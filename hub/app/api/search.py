"""Unified search: library + catalog (Deezer, fallback hitmoz), and raw provider search."""

from __future__ import annotations

import asyncio
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import delete, select
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app import listen
from app.api.library import track_out
from app.api.schemas import (
    ProviderSearchOut,
    SearchHistoryOut,
    SearchMineOut,
    SearchOut,
    SearchRecentIn,
    SearchRecentOut,
    SearchTracksOut,
)
from app.auth import current_user
from app.library import artists as artist_names
from app.catalog.models import CatalogArtist, CatalogTrack, SearchResults
from app.config import get_settings
from app.db import get_session
from app.events import bus
from app.library.owned import annotate_albums, annotate_tracks
from app.library.tracks import current_files
from app.matching.normalize import has_cyrillic
from app.matching.select import rank_candidates
from app.models import SearchHistory, Track, User, utcnow
from app.providers.base import TrackQuery
from app.services import svc

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/search", tags=["search"])

ROW_LIMIT = 12  # artists and albums: one horizontal row each
TRACK_PAGE = 25  # tracks: the first page, then more as the list is scrolled (GET /api/search/tracks)
HISTORY_LIMIT = 30  # the lines of «Недавнее» that are shown
HISTORY_KEPT = 300  # the lines that are kept: «Вы часто ищете» counts further back than «Недавнее» shows
FREQUENT_LIMIT = 8


def _recent_queries(user_id: int):
    return select(SearchHistory).where(SearchHistory.user_id == user_id).order_by(
        SearchHistory.searched_at.desc(), SearchHistory.key
    )


def _recent_out(r: SearchHistory) -> SearchRecentOut:
    return SearchRecentOut(key=r.key, kind=r.kind, title=r.title, subtitle=r.subtitle, ref=r.ref, cover_url=r.cover_url,
                           link=r.link)


@router.get("/history", response_model=SearchHistoryOut)
async def search_history(response: Response, user: User = Depends(current_user),
                         s: AsyncSession = Depends(get_session, scope="function")):
    response.headers["Cache-Control"] = "no-store"
    rows = (await s.execute(_recent_queries(user.id).limit(HISTORY_LIMIT))).scalars()
    often = (await s.execute(
        select(SearchHistory).where(SearchHistory.user_id == user.id, SearchHistory.times > 1)
        .order_by(SearchHistory.times.desc(), SearchHistory.searched_at.desc(), SearchHistory.key).limit(FREQUENT_LIMIT)
    )).scalars()
    return SearchHistoryOut(items=[_recent_out(r) for r in rows], frequent=[_recent_out(r) for r in often])


@router.post("/history", response_model=dict[str, bool])
async def remember_search(body: SearchRecentIn, user: User = Depends(current_user),
                          s: AsyncSession = Depends(get_session, scope="function")):
    """A result was opened, or a query asked for with Enter: it goes to the top of «Недавнее» (once — the same
    thing again only moves up)."""
    key = f"q:{body.title.casefold()}" if body.kind == "query" else f"{body.kind}:{body.ref}"
    # Start with a write: concurrent devices serialize their upsert and pruning in SQLite.
    stmt = insert(SearchHistory).values(
        user_id=user.id, key=key, kind=body.kind, title=body.title, subtitle=body.subtitle or None, ref=body.ref,
        cover_url=body.cover_url, link=body.link, searched_at=utcnow()
    )
    await s.execute(stmt.on_conflict_do_update(
        index_elements=[SearchHistory.user_id, SearchHistory.key],
        set_={**{c: getattr(stmt.excluded, c) for c in ("kind", "title", "subtitle", "ref", "cover_url", "link", "searched_at")},
              "times": SearchHistory.times + 1},
    ))
    keep = _recent_queries(user.id).limit(HISTORY_KEPT).with_only_columns(SearchHistory.key)
    await s.execute(delete(SearchHistory).where(
        SearchHistory.user_id == user.id, SearchHistory.key.not_in(keep)
    ))
    await s.commit()
    bus.publish(user.id, "search_history", {})
    return {"ok": True}


@router.delete("/history", response_model=dict[str, bool])
async def clear_search_history(key: str | None = Query(None, max_length=1024), user: User = Depends(current_user),
                               s: AsyncSession = Depends(get_session, scope="function")):
    """All of «Недавнее», or the one line `key`."""
    gone = delete(SearchHistory).where(SearchHistory.user_id == user.id)
    await s.execute(gone if key is None else gone.where(SearchHistory.key == key))
    await s.commit()
    bus.publish(user.id, "search_history", {})
    return {"ok": True}


async def search_library(s: AsyncSession, q: str, limit: int = 20) -> list[Track]:
    """The library's own songs that match: tracks that have a file (one the Hub only knows of — in a playlist,
    liked, not downloaded — is found in the catalog, like any track not owned). By a track's other names and its
    artists' other spellings too, Cyrillic and Latin read as one (app/library/artists.py `found`)."""
    return [t for t, _ in await artist_names.found(s, q, limit)]


@router.get("", response_model=SearchOut)
async def search(q: str = Query(min_length=1), user: User = Depends(current_user),
                 s: AsyncSession = Depends(get_session, scope="function")):
    q = q.strip()
    owned = await artist_names.found(s, q)
    files = await current_files(s, [t.id for t, _ in owned])
    from app.library import versions

    # a song is shown once: of its versions the preferred one, with how many there are
    owned = await versions.once(s, owned, lambda x: x[0].id)
    many = await versions.counts(s, [t.id for t, _ in owned])
    out = SearchOut(library=[track_out(t, files.get(t.id)).model_copy(update={"found_by": by, "versions": many.get(t.id, 0)}) for t, by in owned])
    res: SearchResults | None = None
    # Yandex Music is asked at the same time: what it has that Deezer lacks is added after Deezer's
    also = asyncio.create_task(svc.yandex.search(q)) if svc.yandex is not None else None
    if svc.deezer is not None:
        try:
            res, (tracks, out.tracks_next) = await asyncio.gather(
                svc.deezer.search(q, kinds=("artist", "album"), limit=ROW_LIMIT),
                svc.deezer.search_track_page(q, 0, TRACK_PAGE),
            )
            res.tracks = tracks
        except Exception as e:
            log.warning("deezer search failed: %r", e)
            out.errors.append("Каталог Deezer недоступен")
    if (res is None or not (res.artists or res.tracks)) and has_cyrillic(q) and svc.hitmoz_catalog is not None:
        try:
            artists = await svc.hitmoz_catalog.search_artists(q)
            res = SearchResults(artists=artists, albums=res.albums if res else [], tracks=res.tracks if res else [])
        except Exception as e:
            log.warning("hitmoz catalog search failed: %r", e)
            out.errors.append("Каталог hitmoz недоступен")
    if also is not None:
        try:
            res = _with(res, await also)
        except Exception as e:  # the search is the other catalogs' then
            log.warning("yandex search failed: %r", e)
    if res is not None:
        out.artists = await artist_names.shown(s, res.artists)  # under the names they have here
        out.albums = await annotate_albums(s, res.albums, user.id)
        out.tracks = await versions.once(s, await annotate_tracks(s, _unique(res.tracks), user.id))
    # The library's own songs that match are tracks among the tracks — the first of them, since the listener has
    # them — each as any list shows it (its cover, its file); the catalog's record of the same song is not shown
    # beside it
    if owned:
        from app.api.playlists import tracks_out

        mine = await tracks_out(s, user, [t for t, _ in owned[:OWN_FIRST]])
        refs, songs = {x.ref for x in mine}, {x.nd_song_id for x in mine if x.nd_song_id}
        ids = {x.library_track_id for x in mine if x.library_track_id}
        out.tracks = [*mine, *(t for t in out.tracks if t.ref not in refs and t.nd_song_id not in songs
                               and getattr(t, "library_track_id", None) not in ids)]
    return out


OWN_FIRST = 5  # of the library's own songs that match, at the head of the tracks


def _with(res: SearchResults | None, more: SearchResults) -> SearchResults:
    """What one catalog found, and after it what another found that the first did not: an artist of the same name,
    a release or a track of the same names is one thing, shown once — as the first catalog has it."""
    from app.matching.normalize import fingerprint

    res = res or SearchResults()
    artists = {artist_names.key(a.name) for a in res.artists}
    albums = {(artist_names.fold(a.title), artist_names.key(a.artist)) for a in res.albums}
    tracks = {fingerprint(t.artist, t.title) for t in res.tracks}
    return SearchResults(
        artists=[*res.artists, *(a for a in more.artists if artist_names.key(a.name) not in artists)],
        albums=[*res.albums, *(a for a in more.albums if (artist_names.fold(a.title), artist_names.key(a.artist)) not in albums)],
        tracks=[*res.tracks, *(t for t in more.tracks if fingerprint(t.artist, t.title) not in tracks)])


def _unique(tracks: list[CatalogTrack]) -> list[CatalogTrack]:
    """Deezer may list a track twice; the PWA keys rows by ref."""
    seen: set[str] = set()
    return [t for t in tracks if not (t.ref in seen or seen.add(t.ref))]


MINE_LIMIT = 100


@router.get("/mine", response_model=SearchMineOut)
async def search_mine(q: str = Query(min_length=1), user: User = Depends(current_user),
                      s: AsyncSession = Depends(get_session, scope="function")):
    """The search of «Библиотека»: what the listener keeps and nothing else — the artists they follow, by their
    names in every spelling, and the tracks of their playlists and of «Любимое», with a file or without one, as the
    search of the library reads them (Cyrillic and Latin as one, other names of a track). No releases: a release
    is not kept as such."""
    from app import playlists, releases
    from app.api.playlists import tracks_out
    from app.models import Playlist, PlaylistItem

    words = artist_names.fold(q).split()
    if not words:
        return SearchMineOut()
    kept = (await s.execute(
        select(PlaylistItem.track_id).join(Playlist, Playlist.id == PlaylistItem.playlist_id)
        .where(Playlist.user_id == user.id, Playlist.kind.in_((playlists.USER, playlists.LIKED))).distinct())).scalars().all()
    tracks = await tracks_out(s, user, [t for t, _ in await artist_names.found(s, q, MINE_LIMIT, among=kept)])
    follows = [f for f in await releases.follows(s, user.id) if all(w in artist_names.fold(f.name) for w in words)][:20]

    async def shown(ref: str, name: str) -> CatalogArtist:
        src, _, id_ = ref.partition(":")
        try:  # their picture, where the catalog is there to say it
            return (await svc.artist_page(ref)).artist if src != "dz" or svc.deezer is None else await svc.deezer.get_artist(id_)
        except Exception as e:
            log.info("search of the library: artist %s not read: %r", ref, e)
            return CatalogArtist(ref=ref, source=src, id=id_, name=name)  # type: ignore[arg-type]

    artists = await artist_names.shown(s, list(await asyncio.gather(*(shown(f.ref, f.name) for f in follows))))
    return SearchMineOut(artists=artists, tracks=tracks)


@router.get("/tracks", response_model=SearchTracksOut)
async def search_tracks(q: str = Query(min_length=1), offset: int = Query(0, ge=0),
                        limit: int = Query(TRACK_PAGE, ge=1, le=100), user: User = Depends(current_user),
                        s: AsyncSession = Depends(get_session, scope="function")):
    """More catalog tracks for `/api/search` (Deezer only: the hitmoz fallback has no pages)."""
    if svc.deezer is None:
        return SearchTracksOut()
    try:
        tracks, nxt = await svc.deezer.search_track_page(q.strip(), offset, limit)
    except Exception as e:
        log.warning("deezer search page failed: %r", e)
        raise HTTPException(502, "Каталог Deezer недоступен") from e
    return SearchTracksOut(tracks=await annotate_tracks(s, _unique(tracks), user.id), next_offset=nxt)


@router.get("/providers", response_model=ProviderSearchOut)
async def search_providers(q: str = Query(min_length=1), provider: str | None = None,
                           group: Literal["sources", "reuploads"] | None = None,
                           user: User = Depends(current_user)):
    """Raw downloadable files. "Artist - Title" is split for ranking; otherwise results keep provider order.
    `group`: only the regular sources, or only re-uploads by small channels (slower: SoundCloud takes seconds).
    Each file can then be listened to and downloaded by its ref "file:<provider>:<provider_id>" (`app.listen`)."""
    artist, _, title = q.partition(" - ")
    tq = TrackQuery(artist=artist.strip() if title else q.strip(), title=title.strip() if title else "")
    reuploads = {p.name for p in svc.reupload_providers()}
    names = [provider] if provider else [
        n for n in svc.providers if group is None or (n in reuploads) == (group == "reuploads")
    ]
    out = ProviderSearchOut()

    async def one(name: str):
        p = svc.providers.get(name)
        if p is None:
            return []
        try:
            raw = await p.search(TrackQuery(artist=tq.artist, title=tq.title or ""), limit=15)
        except Exception as e:
            out.errors.append(f"{name}: {e}")
            return []
        if title:
            ranked = rank_candidates(tq, raw, get_settings().cfg.matching)
            return ranked or raw
        return raw

    for lst in await asyncio.gather(*(one(n) for n in names)):
        out.candidates.extend(lst)
    await listen.remember_files(out.candidates)
    return out
