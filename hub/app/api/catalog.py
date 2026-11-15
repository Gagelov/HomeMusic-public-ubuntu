"""Spotify-like artist and album pages with library ownership (FR-4)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import AlbumOut, ArtistPageOut, ArtistSourceOut, DiscographyOut, NamesakeIn, NamesakeOut
from app.catalog import banners, namesakes, popular
from app.auth import current_user
from app.catalog.models import ArtistPage, CatalogAlbum, CatalogTrack, split_ref
from app.db import get_session
from app.library.owned import annotate_albums, annotate_tracks
from app.models import User
from app.services import svc

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/catalog", tags=["catalog"])


def _split(ref: str) -> tuple[str, str]:
    try:
        return split_ref(ref)
    except ValueError as e:
        raise HTTPException(400, "Неверная ссылка на каталог") from e


async def get_artist_page(ref: str) -> ArtistPage:
    src, id_ = _split(ref)
    try:
        if src == "dz" and svc.deezer:
            return await svc.deezer.get_artist_page(id_)
        if src == "hm" and svc.hitmoz_catalog:
            return await svc.hitmoz_catalog.get_artist(id_)
    except HTTPException:
        raise
    except Exception as e:
        if type(e).__name__ == "CatalogNotFound":
            raise HTTPException(404, "Исполнитель не найден") from e
        raise HTTPException(502, f"Каталог недоступен: {e}") from e
    raise HTTPException(404, "Исполнитель не найден")


async def whole_artist(s: AsyncSession, ref: str) -> tuple[ArtistPage, list[str], list[ArtistSourceOut]]:
    """The artist a record of the catalog is of, as one page: a catalog may keep several records of one artist (old
    releases under one spelling, new under another), and the Hub knows which are theirs (app/library/artists.py).
    Returns the page — the name they have here, the releases of all the records (one that two of them carry, once),
    the most listened of them all — the records, the one with the most followers first (that one's picture is the
    artist's, and its address is the page's own), and each record as the catalog itself shows it."""
    from app.library import artists

    page = await get_artist_page(ref)
    who = await artists.who(s, page.artist.name, ref, "catalog")
    refs = [r for r in (await artists.profiles(s, who.id) if who is not None else []) if r != ref]

    async def other(r: str) -> ArtistPage | None:
        try:
            return await get_artist_page(r)
        except HTTPException as e:  # a record the catalog has dropped does not take the artist's page with it
            log.info("artist %s: the record %s is not read: %s", ref, r, e.detail)
            return None

    pages = [page, *[p for p in await asyncio.gather(*(other(r) for r in refs)) if p is not None]]
    pages.sort(key=lambda p: p.artist.nb_fans or 0, reverse=True)
    main = pages[0]
    albums: list[CatalogAlbum] = []
    seen: set[Any] = set()
    for p in pages:
        for a in p.albums:
            same = (artists.fold(a.title), a.record_type, a.release_date.year if a.release_date else a.year)
            if a.ref in seen or same in seen:
                continue
            seen.update((a.ref, same))
            albums.append(a)
    top: dict[str, CatalogTrack] = {}
    for p in pages:
        for t in p.top_tracks:
            top.setdefault(t.ref, t)
    tracks = list(top.values())
    if len(pages) > 1:  # the most listened of them all, by the catalog's own count of it
        tracks = sorted(tracks, key=lambda t: t.rank or 0, reverse=True)[:max(len(p.top_tracks) for p in pages)]
    fans = [p.artist.nb_fans for p in pages if p.artist.nb_fans]
    artist = main.artist.model_copy(update={"name": who.name if who is not None else main.artist.name,
                                             "nb_fans": sum(fans) if fans else main.artist.nb_fans})
    sources = [ArtistSourceOut(service="deezer" if p.artist.source == "dz" else "catalog", ref=p.artist.ref, name=p.artist.name,
                               picture_url=p.artist.picture_small_url or p.artist.picture_url, followers=p.artist.nb_fans,
                               releases=len(p.albums),
                               url=f"https://www.deezer.com/artist/{p.artist.id}" if p.artist.source == "dz" else None)
               for p in pages]
    return ArtistPage(artist=artist, top_tracks=tracks, albums=albums), [p.artist.ref for p in pages], sources


async def get_album(ref: str, *, credited: bool = False) -> CatalogAlbum:
    """`credited`: with everyone credited on each track (an album's own page; costs a request a track, once)."""
    src, id_ = _split(ref)
    try:
        if src == "dz" and svc.deezer:
            return await (svc.deezer.get_album_credited(id_) if credited else svc.deezer.get_album(id_))
        if src == "hm" and svc.hitmoz_catalog:
            return await svc.hitmoz_catalog.get_album(id_)
    except Exception as e:
        if type(e).__name__ == "CatalogNotFound":
            raise HTTPException(404, "Альбом не найден") from e
        raise HTTPException(502, f"Каталог недоступен: {e}") from e
    raise HTTPException(404, "Альбом не найден")


@router.get("/artist/{ref}", response_model=ArtistPageOut)
async def artist(ref: str, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    page, records, sources = await whole_artist(s, ref)
    await s.commit()  # who the record is of is known from now on
    albums = await annotate_albums(s, page.albums, user.id)
    albums.sort(key=lambda a: (a.release_date is not None, a.release_date), reverse=True)
    # how the artist looks, where the listeners chose: the photo, the wide picture — or none over the page
    from app.library import artists, looks

    who = await artists.by_ref(s, records[0])
    look = await looks.of(s, who.id) if who is not None else None
    chosen = await looks.photo(s, who, look, chosen_only=True) if who is not None else None
    if chosen:
        page.artist = page.artist.model_copy(update={"picture_url": chosen[0], "picture_small_url": chosen[1]})
    said, own_banner = looks.banner(who.id, look) if who is not None else (False, None)

    async def found_banner() -> str | None:
        return own_banner if said else await banners.url_of(page.artist, [t.title for t in page.top_tracks] + [a.title for a in page.albums])

    heard, extra, banner = await asyncio.gather(
        popular.listeners(page.artist.name), popular.more(page.artist, page.top_tracks), found_banner())
    return ArtistPageOut(
        artist=page.artist,
        top_tracks=await annotate_tracks(s, [*page.top_tracks, *extra], user.id),
        lastfm_listeners=heard, top_from_lastfm=len(extra), banner_url=banner,
        albums=[a for a in albums if a.record_type == "album"],
        singles=[a for a in albums if a.record_type in ("single", "ep")],
        compilations=[a for a in albums if a.record_type == "compile"],
        excluded=sum(len(namesakes.of(r)) for r in records), profiles=records,
        # where the artist is known: the catalog's records of them, and Last.fm — which knows an artist by the name
        sources=[*sources, *([ArtistSourceOut(service="lastfm", name=page.artist.name, listeners=heard,
                                              url=f"https://www.last.fm/music/{quote(page.artist.name, safe='')}")] if heard else [])],
    )


@router.get("/artist/{ref}/banner")
async def artist_banner(ref: str, user: User = Depends(current_user)):
    """The wide picture over the artist's page, as the Hub keeps it."""
    data = await banners.image_of(ref)
    if data is None:
        raise HTTPException(404, "Нет картинки")
    return Response(data, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=31536000, immutable"})


@router.get("/namesakes", response_model=list[NamesakeOut])
async def namesakes_list(user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    """The releases said to be a namesake's, by artist: where they are brought back («Скрытое»)."""
    return await namesakes.listed(s)


@router.post("/namesakes")
async def namesakes_exclude(body: NamesakeIn, user: User = Depends(current_user),
                            s: AsyncSession = Depends(get_session, scope="function")) -> dict[str, int]:
    """«Это другой TAK»: these releases the catalog files under the artist are not theirs — for everyone here."""
    src, id_ = _split(body.artist_ref)
    if src != "dz" or svc.deezer is None or not body.album_refs:
        raise HTTPException(400, "Нужен исполнитель каталога и его релизы")
    want = set(body.album_refs)
    try:
        artist = await svc.deezer.get_artist(id_)
        albums = [a for a in await svc.deezer.get_artist_albums(id_, everyones=True) if a.ref in want]
    except Exception as e:
        raise HTTPException(502, f"Каталог недоступен: {e}") from e
    n = await namesakes.exclude(s, user.id, body.artist_ref, artist.name, albums)
    await s.commit()
    return {"excluded": n, "total": len(namesakes.of(body.artist_ref))}


@router.post("/namesakes/restore")
async def namesakes_restore(body: NamesakeIn, user: User = Depends(current_user),
                            s: AsyncSession = Depends(get_session, scope="function")) -> dict[str, int]:
    """They are the artist's after all."""
    n = await namesakes.restore(s, body.artist_ref, body.album_refs)
    await s.commit()
    return {"restored": n, "total": len(namesakes.of(body.artist_ref))}


@router.get("/artist-named")
async def artist_named(name: str, user: User = Depends(current_user)) -> dict[str, str | None]:
    """The catalog's artist of this very name — where only a name is known (a track playing from a list that does
    not say who its artists are). `ref` null: the catalog has nobody called so."""
    from app.api.medialib import _in_catalog

    return {"ref": await _in_catalog(name)}


DISCOGRAPHY_PARALLEL = 4  # releases asked of the catalog at once (each is kept by the catalog's own cache after)


@router.get("/artist/{ref}/discography", response_model=DiscographyOut)
async def discography(ref: str, user: User = Depends(current_user),
                      s: AsyncSession = Depends(get_session, scope="function")):
    """Every release of the artist with its tracks, newest first. The catalog gives the tracks a release at a time;
    they are asked for here, a few at once, and kept — the first opening of a long discography takes seconds, the
    next ones none. A release whose tracks the catalog does not give comes without them."""
    page, records, _ = await whole_artist(s, ref)
    await s.commit()
    gate = asyncio.Semaphore(DISCOGRAPHY_PARALLEL)

    async def whole(a: CatalogAlbum) -> CatalogAlbum:
        async with gate:
            try:
                return await get_album(a.ref)
            except Exception as e:
                log.info("discography of %s: no tracks of %s: %r", ref, a.ref, e)
                return a

    albums = list(await asyncio.gather(*(whole(a) for a in page.albums)))
    # ownership of every track in one go, then back to its release
    flat = [t for a in albums for t in (a.tracks or [])]
    told = iter(await annotate_tracks(s, flat, user.id))
    outs = await annotate_albums(s, [a.model_copy(update={"tracks": None}) for a in albums], user.id)
    for o, a in zip(outs, albums, strict=True):
        if a.tracks is not None:
            o.tracks = [next(told) for _ in a.tracks]
            owned = sum(1 for t in o.tracks if t.owned)
            o.owned_count = owned
            o.owned_status = "full" if owned and owned >= len(o.tracks) else ("partial" if owned else "none")
    outs.sort(key=lambda a: (a.release_date is not None, a.release_date), reverse=True)
    return DiscographyOut(artist=page.artist, albums=outs, excluded=sum(len(namesakes.of(r)) for r in records), profiles=records)


@router.get("/album/{ref}", response_model=AlbumOut)
async def album(ref: str, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    a = await get_album(ref, credited=True)
    return (await annotate_albums(s, [a], user.id))[0]
