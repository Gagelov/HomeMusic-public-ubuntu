"""«Чарты и жанры» (the Home screen): the charts of countries and genres, played in their order, shuffled or as a
wave (`app.mixes.wave`, seed `{"chart": id}`).

Sources (checked from the VPS in Singapore, 2026-11):
- Russia — Yandex Music's chart (100; `api.music.yandex.net` answers 451 outside Russia: the Russian proxy,
  `OUTBOUND_PROXY_HOSTS`), Apple Music's when Yandex fails. Deezer has no chart of Russia.
- USA, the European countries, Ukraine, the world — the «Top <country>» playlists of Deezer Charts (Deezer tracks as
  they are). «Европа» — the first places of its countries by turns.
- Genres — Deezer's chart of the genre (`chart/<genre>/tracks`; Deezer picks the country by the caller's address,
  the VPS's); Russian genres — Yandex Music's editorial playlists of a tag («Русский рок» …), by turns.
Names of Yandex and Apple are matched with the Deezer catalog the way mixes do it (`app.mixes.resolve.resolve_hits`:
only a sure match; a song the library has plays from it).

A chart is kept in `catalog_cache` (`chart:<id>`) and counts as fresh for `FRESH_S`: an older one is served while a new
one is made in the background, and `charts_loop` keeps them fresh so a tap finds one ready. Tracks known to have only
Deezer's preview (`app.no_full`) are left out when a chart is served.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable, Coroutine
from dataclasses import dataclass, field
from itertools import zip_longest
from typing import Any

from app import no_full
from app.catalog.cache import cache_get, cache_set
from app.catalog.models import CatalogTrack
from app.matching.normalize import fingerprint
from app.net import Priority, make_client, priority_context
from app.services import svc

log = logging.getLogger(__name__)

SIZE = 100
FRESH_S = 6 * 3600
KEEP_S = 7 * 86400  # an old chart is still served when its source is down
LOOP_START_S = 90
LOOP_EVERY_S = 3600
TAG_PLAYLISTS = 3  # editorial playlists of a Yandex tag merged into a Russian genre
APPLE_URL = "https://rss.marketingtools.apple.com/api/v2/{cc}/music/most-played/100/songs.json"


class ChartError(Exception):
    """The chart could not be made (its source is down or gave nothing)."""


@dataclass(frozen=True)
class Chart:
    id: str
    title: str  # the card's
    name: str  # the page's and the wave's («Волна: <name>»)
    kind: str  # "country" | "genre"
    group: str  # the Home screen's rows: "main", "europe", "ru_genres", "genres", "moods"
    source: str  # shown under the title
    deezer_playlist: int | None = None
    deezer_genre: int | None = None
    yandex_chart: str | None = None
    yandex_tag: str | None = None
    apple: str | None = None  # Apple Music's country: the chart when Yandex's fails
    parts: tuple[str, ...] = ()  # charts merged by turns («Европа»)
    lastfm_tag: str = ""  # a mood's tag on Last.fm
    personal: bool = False  # built per user from their library and taste (not cached globally)


def _country(id_: str, title: str, name: str, playlist: int, group: str = "europe") -> Chart:
    return Chart(id_, title, name, "country", group, "Deezer", deezer_playlist=playlist)


def _genre(id_: str, title: str, genre: int) -> Chart:
    return Chart(id_, title, title, "genre", "genres", "Deezer", deezer_genre=genre)


def _ru_genre(id_: str, title: str, tag: str) -> Chart:
    return Chart(id_, title, title, "genre", "ru_genres", "Яндекс Музыка", yandex_tag=tag)


def _mood(id_: str, title: str, tag: str, playlist: int) -> Chart:
    return Chart(id_, title, title, "genre", "moods", "Deezer и ваша библиотека", deezer_playlist=playlist,
                 lastfm_tag=tag, personal=True)


# What a mood's artists sound like on Last.fm, for matching the library's own artists.
_MOOD_WORDS: dict[str, tuple[str, ...]] = {
    "mood_calm": ("chill", "calm", "relax", "ambient", "mellow", "soft", "sleep", "dream", "acoustic", "instrumental"),
    "mood_energy": ("energetic", "energy", "upbeat", "dance", "party", "workout", "pump", "power", "hype"),
    "mood_sad": ("sad", "melanchol", "depress", "heartbreak", "lonely", "sorrow", "blue"),
    "mood_happy": ("happy", "feel good", "joy", "fun", "sunny", "uplifting", "positive"),
    "mood_romantic": ("romantic", "love", "sensual", "sexy", "intimate"),
    "mood_focus": ("focus", "study", "concentrat", "instrumental", "ambient", "lofi", "lo-fi", "classical", "piano"),
}


EUROPE = ("gb", "de", "fr", "it", "es", "pl", "nl")
CHARTS: dict[str, Chart] = {c.id: c for c in [
    Chart("ru", "Россия", "Чарт России", "country", "main", "Яндекс Музыка", yandex_chart="russia", apple="ru"),
    _country("us", "США", "Чарт США", 1313621735, "main"),
    Chart("eu", "Европа", "Чарт Европы", "country", "main", "Deezer", parts=EUROPE),
    _country("world", "Мир", "Мировой чарт", 3155776842, "main"),
    _country("gb", "Великобритания", "Чарт Великобритании", 1111142221),
    _country("de", "Германия", "Чарт Германии", 1111143121),
    _country("fr", "Франция", "Чарт Франции", 1109890291),
    _country("it", "Италия", "Чарт Италии", 1116187241),
    _country("es", "Испания", "Чарт Испании", 1116190041),
    _country("pl", "Польша", "Чарт Польши", 1266972311),
    _country("nl", "Нидерланды", "Чарт Нидерландов", 1266971851),
    _country("ua", "Украина", "Чарт Украины", 1362526495),
    _ru_genre("rusrock", "Русский рок", "rusrock"),
    _ru_genre("rusrap", "Русский рэп", "rusrap"),
    _ru_genre("ruspop", "Русская поп-музыка", "ruspop"),
    _ru_genre("phonk", "Фонк", "phonk"),
    _mood("mood_calm", "Спокойное", "chill", 1925105902),
    _mood("mood_energy", "Энергичное", "energetic", 1368504915),
    _mood("mood_sad", "Грустное", "sad", 1910358422),
    _mood("mood_happy", "Весёлое", "happy", 1479458365),
    _mood("mood_romantic", "Романтичное", "romantic", 12351625391),
    _mood("mood_focus", "Для фокуса", "focus", 12783906481),
    _genre("pop", "Поп", 132),
    _genre("hiphop", "Хип-хоп", 116),
    _genre("rock", "Рок", 152),
    _genre("dance", "Танцевальная", 113),
    _genre("electro", "Электроника", 106),
    _genre("rnb", "R&B", 165),
    _genre("alternative", "Альтернатива", 85),
    _genre("metal", "Метал", 464),
    _genre("jazz", "Джаз", 129),
    _genre("classical", "Классика", 98),
    _genre("soul", "Соул и фанк", 169),
    _genre("blues", "Блюз", 153),
    _genre("latin", "Латино", 197),
    _genre("reggae", "Регги", 144),
    _genre("folk", "Фолк", 466),
    _genre("soundtrack", "Саундтреки", 173),
    _genre("asian", "K-pop и Азия", 16),
]}


@dataclass
class Built:
    tracks: list[CatalogTrack]
    at: float  # Unix time it was made
    positions: list[int] = field(default_factory=list)  # served: each track's place in the chart (1-based)


_locks: dict[str, asyncio.Lock] = {}
_later: dict[str, asyncio.Task] = {}


def get(chart_id: str) -> Chart | None:
    return CHARTS.get(chart_id)


def _key(chart_id: str) -> str:
    return f"chart:{chart_id}"


def _fresh(b: Built) -> bool:
    return time.time() - b.at <= FRESH_S


async def cached(chart_id: str) -> Built | None:
    """The chart as kept (without the preview filter), however old."""
    d = await cache_get(_key(chart_id))
    if not d:
        return None
    try:
        return Built([CatalogTrack.model_validate(t) for t in d["tracks"]], float(d["at"]))
    except Exception as e:
        log.warning("chart %s: unreadable: %r", chart_id, e)
        return None


async def tracks(chart_id: str, user_id: int | None = None) -> Built:
    """The chart, its tracks without a full file left out. Made now when none is kept (it may take a minute: Yandex's
    names are matched with the catalog); an old one is served while a new one is made in the background. Raises
    ChartError when it can't be made. A mood chart is built for the user, not cached."""
    c = CHARTS.get(chart_id)
    if c is None:
        raise ChartError("такого чарта нет")
    if c.personal:
        if user_id is None:
            raise ChartError("нужен пользователь")
        built = await personal_tracks(c, user_id)
        kept = [(i, t) for i, t in enumerate(built.tracks, 1) if not no_full.has(t.ref)]
        return Built([t for _, t in kept], built.at, [i for i, _ in kept])
    built = await cached(chart_id)
    if built is None:
        built = await refresh(chart_id)
    elif not _fresh(built):
        _refresh_later(chart_id)
    kept = [(i, t) for i, t in enumerate(built.tracks, 1) if not no_full.has(t.ref)]
    return Built([t for _, t in kept], built.at, [i for i, _ in kept])


async def refresh(chart_id: str) -> Built:
    """Makes the chart anew unless another caller just did."""
    async with _locks.setdefault(chart_id, asyncio.Lock()):
        built = await cached(chart_id)
        if built is not None and _fresh(built):
            return built
        found = await _make(CHARTS[chart_id])
        if not found:
            raise ChartError("источник ничего не вернул")
        built = Built(found, time.time())
        await cache_set(_key(chart_id), {"at": built.at, "tracks": [t.model_dump(mode="json") for t in found]}, KEEP_S)
        log.info("chart %s: %s tracks", chart_id, len(found))
        return built


def _background(coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
    """Below the user's requests on the network (`app.net.Priority`)."""
    return asyncio.create_task(coro, context=priority_context(Priority(True)))


def _refresh_later(chart_id: str) -> None:
    if (t := _later.get(chart_id)) is not None and not t.done():
        return
    task = _later[chart_id] = _background(refresh(chart_id))

    def done(t: asyncio.Task) -> None:
        if not t.cancelled() and (e := t.exception()):
            log.warning("chart %s: refresh failed: %r", chart_id, e)

    task.add_done_callback(done)


async def charts_loop() -> None:
    """Keeps the charts fresh in the background, so a tap finds one ready: the first round a minute and a half after the
    start, then every hour the ones older than `FRESH_S`."""
    await asyncio.sleep(LOOP_START_S)
    while True:
        for cid in CHARTS:
            if CHARTS[cid].personal:
                continue  # built per user, nothing to keep fresh
            try:
                built = await cached(cid)
                if built is None or not _fresh(built):
                    await _background(refresh(cid))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                log.warning("chart %s: %r", cid, e)
        await asyncio.sleep(LOOP_EVERY_S)


async def reset() -> None:
    tasks = [t for t in _later.values() if not t.done()]
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    _later.clear()
    _locks.clear()


# --- the sources -------------------------------------------------------------------------------------------------


async def _make(c: Chart) -> list[CatalogTrack]:
    if c.parts:
        lists = await asyncio.gather(*(tracks(p) for p in c.parts), return_exceptions=True)
        ok = [b.tracks for b in lists if isinstance(b, Built)]
        if not ok:
            raise ChartError(f"чарты стран недоступны: {lists[0]!r}")
        return by_turns(ok)
    if c.deezer_playlist is not None:
        return await _deezer(lambda: svc.deezer.playlist_tracks(c.deezer_playlist, SIZE))
    if c.deezer_genre is not None:
        return await _deezer(lambda: svc.deezer.chart_tracks(c.deezer_genre, SIZE))
    if c.yandex_chart:
        try:
            if found := await _resolve("yandex", await asyncio.to_thread(_yandex_chart_sync, c.yandex_chart)):
                return found
            log.warning("chart %s: Yandex gave nothing, Apple Music's instead", c.id)
        except Exception as e:
            if not c.apple:
                raise ChartError(f"Яндекс Музыка: {e!r}") from e
            log.warning("chart %s: Yandex failed (%r), Apple Music's instead", c.id, e)
    if c.yandex_tag:
        try:
            return await _resolve("yandex", await asyncio.to_thread(_yandex_tag_sync, c.yandex_tag))
        except Exception as e:
            raise ChartError(f"Яндекс Музыка: {e!r}") from e
    if c.apple:
        try:
            return await _resolve("apple", await _apple(c.apple))
        except Exception as e:
            raise ChartError(f"Apple Music: {e!r}") from e
    raise ChartError("у чарта нет источника")


def by_turns(lists: list[list[CatalogTrack]], size: int = SIZE) -> list[CatalogTrack]:
    """The first places of every list, then the second ones…; a song once (by ref and by artist + title)."""
    out: list[CatalogTrack] = []
    seen: set[str] = set()
    for row in zip_longest(*lists):
        for t in row:
            if t is None:
                continue
            keys = {t.ref, fingerprint(t.artist, t.title)}
            if keys & seen:
                continue
            seen |= keys
            out.append(t)
            if len(out) >= size:
                return out
    return out


async def _deezer(fetch: Callable[[], Awaitable[list[CatalogTrack]]]) -> list[CatalogTrack]:
    if svc.deezer is None:
        raise ChartError("Deezer не настроен")
    try:
        return (await fetch())[:SIZE]
    except Exception as e:
        raise ChartError(f"Deezer: {e!r}") from e


async def _resolve(source: str, hits: list) -> list[CatalogTrack]:
    """The names' catalog tracks in order; the ones not found for sure are left out."""
    from app.mixes.resolve import resolve_hits

    out: list[CatalogTrack] = []
    seen: set[str] = set()
    for t in await resolve_hits(source, hits):
        if t is not None and t.ref not in seen:
            seen.add(t.ref)
            out.append(t)
    return out[:SIZE]


async def _lastfm_tag(tag: str, limit: int = SIZE) -> list:
    """The tag's top tracks as names, to be matched with the catalog."""
    from app.mixes.sources import Hit, _as_list, _lastfm, lastfm_configured

    if not lastfm_configured():
        return []
    body = await _lastfm("tag.getTopTracks", tag=tag, limit=limit)
    hits: list[Hit] = []
    for t in _as_list((body.get("tracks") or {}).get("track")):
        artist = t.get("artist")
        if isinstance(artist, dict):
            artist = artist.get("name") or ""
        title = t.get("name") or ""
        if artist and title:
            hits.append(Hit(artist=artist, title=title))
    return hits[:limit]


def _library_to_catalog(t: Any) -> CatalogTrack | None:
    """A library track as the catalog would name it: its own ref when known, else its Navidrome song."""
    ref = (t.ref or "").strip() or (f"nd:{t.nd_song_id}" if t.nd_song_id else "")
    if not ref:
        return None
    source = "dz" if ref.startswith("dz:") else "nd"
    artist = t.artist or ""
    cover = (t.catalog or {}).get("cover_url") if t.catalog else None
    return CatalogTrack(ref=ref, source=source, id=ref.split(":", 1)[-1], title=t.title, artist=artist,
                        artists=[artist] if artist else [], album_title=t.album, duration_s=t.duration_s,
                        isrc=t.isrc, explicit=t.explicit, cover_url=cover)


async def _personal_library_tracks(chart_id: str, user_id: int, limit: int = 50) -> list[CatalogTrack]:
    """The user's own tracks whose artists sound like the mood: Last.fm's tags of the artists they play."""
    from sqlalchemy import desc, func, or_, select

    from app.db import session_scope
    from app.mixes.sources import lastfm_artist_tags, lastfm_configured
    from app.models import PlayEvent, Track

    words = _MOOD_WORDS.get(chart_id) or ()
    async with session_scope() as s:
        rows = (await s.execute(
            select(Track.artist, func.count(PlayEvent.id).label("plays"))
            .join(Track, Track.id == PlayEvent.track_id)
            .where(PlayEvent.user_id == user_id, PlayEvent.kind.in_(("start", "finish", "like")))
            .group_by(Track.artist).order_by(desc("plays")).limit(40)
        )).all()
        artists = [a for a, _ in rows if a]
        if not artists:  # a new listener: whatever the library has
            artists = [a for (a,) in (await s.execute(select(Track.artist).distinct().limit(40))).all() if a]
        matched: set[str] = set()
        if lastfm_configured() and words:
            found = await asyncio.gather(*(lastfm_artist_tags(a) for a in artists[:12]), return_exceptions=True)
            for artist, tags in zip(artists[:12], found, strict=True):
                blob = " ".join(t.casefold() for t in tags) if isinstance(tags, list) else ""
                if any(w in blob for w in words):
                    matched.add(artist)
        if not matched:  # no tags (or no Last.fm): the genre the files say; no signal — no own tracks
            rows = []
            if words:
                rows = (await s.execute(
                    select(Track).where(or_(*(func.lower(Track.genre).contains(w) for w in words)))
                    .order_by(desc(Track.id)).limit(400)
                )).scalars().all()
        else:
            rows = (await s.execute(
                select(Track).where(Track.artist.in_(list(matched))).order_by(desc(Track.id)).limit(400)
            )).scalars().all()
    seen: set[str] = set()
    out: list[CatalogTrack] = []
    for t in rows:
        found = _library_to_catalog(t)
        if found is None:
            continue
        fp = fingerprint(found.artist, found.title)
        if not fp or fp in seen:
            continue
        seen.add(fp)
        out.append(found)
        if len(out) >= limit:
            break
    return out


async def personal_tracks(c: Chart, user_id: int) -> Built:
    """A mood for this listener: their own matching tracks and the tag's catalog ones, by turns."""
    catalog: list[CatalogTrack] = []
    if c.lastfm_tag:
        try:
            hits = await _lastfm_tag(c.lastfm_tag)
            if hits:
                catalog = await _resolve("lastfm", hits)
        except Exception as e:
            log.warning("chart %s: Last.fm tag %r failed: %r", c.id, c.lastfm_tag, e)
    if not catalog and c.deezer_playlist is not None:
        try:
            catalog = await _deezer(lambda: svc.deezer.playlist_tracks(c.deezer_playlist, SIZE))
        except Exception as e:
            log.warning("chart %s: Deezer playlist %s failed: %r", c.id, c.deezer_playlist, e)
    try:
        mine = await _personal_library_tracks(c.id, user_id)
    except Exception as e:
        log.warning("chart %s: personal library failed: %r", c.id, e)
        mine = []
    mixed = by_turns([mine, catalog]) if mine and catalog else (mine or catalog)
    if not mixed:
        raise ChartError("не удалось подобрать треки по настроению")
    return Built(mixed[:SIZE], time.time(), list(range(1, len(mixed[:SIZE]) + 1)))


def _yandex_chart_sync(name: str) -> list:
    from app.catalog.yandex import yandex_client
    from app.mixes.sources import _yandex_rows

    info = yandex_client().chart(name)
    rows = [x.track for x in (info.chart.tracks or [])] if info is not None and info.chart is not None else []
    return _yandex_rows([t for t in rows if t is not None])[:SIZE]


def _yandex_tag_sync(tag: str) -> list:
    from app.catalog.yandex import yandex_client
    from app.mixes.sources import _yandex_rows

    client = yandex_client()
    found = client.tags(tag)
    lists = []
    for pid in (found.ids or [])[:TAG_PLAYLISTS] if found is not None else []:
        pl = client.users_playlists(pid.kind, pid.uid)
        rows = [ts.track for ts in (getattr(pl, "tracks", None) or []) if ts.track is not None]
        lists.append(_yandex_rows(rows))
    out, seen = [], set()
    for row in zip_longest(*lists):
        for h in row:
            if h is not None and (k := (h.artist.casefold(), h.title.casefold())) not in seen:
                seen.add(k)
                out.append(h)
    return out[:SIZE]


async def _apple(country: str) -> list:
    from app.mixes.sources import Hit

    client = make_client(timeout=20)
    try:
        r = await client.get(APPLE_URL.format(cc=country))
        r.raise_for_status()
        rows = r.json()["feed"]["results"]
    finally:
        await client.aclose()
    return [Hit(artist=x.get("artistName") or "", title=x.get("name") or "", source_id=f"apple:{x.get('id')}")
            for x in rows]
