"""What song of the catalog a file is.

A file brought from outside says what it is as it can: several artists in one line, «Single» for an album or the
track's own name, a year missing, a cover found somewhere. The catalog says the same of the song properly — each
artist by name, the release it came out on and what kind it is, the year, the cover. So a file is looked for in the
catalog by its artist, its name and its length (the names read out of the file's name where its tags are empty),
and when the song is found the file is filed as that song.

Three answers. `found`: one record stands out and nothing speaks against it. `doubt`: a record is like the file, but
not surely it — the names are only alike, the length is another, the file is a version (slowed, a remix) and the
record is not: it is shown, and used only when the listener says so. `none`: the catalog has nothing like it — the
file keeps its own names.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

from app.config import get_settings
from app.library.credits import main_artist
from app.matching.normalize import has_cyrillic, normalize_artist, split_version, to_latin, version_kind
from app.matching.score import artist_sim
from app.matching.select import classify_scores, match_catalog
from app.services import svc

log = logging.getLogger(__name__)

_NAME = re.compile(r"^\s*(?:\d{1,3}[.)]?\s+)?(?P<artist>.+?)\s+[-–—]\s+(?P<title>.+?)\s*$")
_EXT = re.compile(r"\.[A-Za-z0-9]{2,5}$")
SAME_LENGTH_S = 2  # two lengths this near are one recording's
DOUBT_LENGTH_S = 5  # a record whose length differs by more is not surely the file's recording


def names_of(tags: dict[str, Any], file_name: str) -> tuple[str, str]:
    """(artist, title) of a file: its tags; what they do not say — out of «Artist - Title» of its name."""
    artist, title = str(tags.get("artist") or "").strip(), str(tags.get("title") or "").strip()
    stem = _EXT.sub("", file_name or "")
    m = _NAME.match(stem)
    if m and (not artist or not title or title == stem):
        artist, title = artist or m["artist"].strip(), m["title"].strip() if not title or title == stem else title
    return artist, title or stem


def single_album(album: str | None, title: str) -> bool:
    """The file's «album» is no album: nothing, «Single», or the track's own name."""
    a = " ".join((album or "").split()).casefold()
    return not a or a in ("single", "singles", "сингл", "синглы") or a.endswith("- single") or a == " ".join(title.split()).casefold()


RELEASES_MAX = 80  # of an artist's releases gone through, the newest first
_released: dict[str, list[Any]] = {}  # an artist's name -> the tracks of their releases (for the Hub's run: a folder
_RELEASED_KEPT = 400                  # of one artist's files asks once)


async def _released_by(line: str) -> list[Any]:
    """The tracks of everything the file's first artist released, as the catalog lists it: the artist is found by
    name (spelt either way: «LSP» is «ЛСП»), their releases are read a few at once. Nothing when the catalog has
    no such artist, or does not answer."""
    name = main_artist(line)
    key = name.casefold()
    if key in _released:
        return _released[key]
    out: list[Any] = []
    try:
        who = normalize_artist(name)
        artists = [a for a in (await svc.deezer.search(_words(name), kinds=("artist",), limit=8)).artists
                   if artist_sim(who, normalize_artist(a.name)) >= get_settings().cfg.matching.artist_min_ratio][:2]
        gate = asyncio.Semaphore(4)

        async def tracks(album: Any) -> list[Any]:
            async with gate:
                try:
                    whole = await svc.deezer.get_album(album.id)
                except Exception:
                    return []
            return [t.model_copy(update={"album_title": t.album_title or whole.title, "album_ref": t.album_ref or whole.ref,
                                         "album_artist": t.album_artist or whole.artist}) for t in (whole.tracks or [])]

        for a in artists:
            albums = (await svc.deezer.get_artist_albums(a.id))[:RELEASES_MAX]
            for part in await asyncio.gather(*(tracks(x) for x in albums)):
                out.extend(part)
    except Exception as e:
        log.info("recognize: releases of %s not read: %r", name, e)
        return []  # not kept: asked again with the next file
    if len(_released) >= _RELEASED_KEPT:
        _released.pop(next(iter(_released)))
    _released[key] = out
    return out


TITLE_SURE = 0.85  # a name as like as this is the file's name, spelt a little otherwise
TITLE_FLOOR = 0.6  # a record named less like the file than this is not «like» it, whoever made it


def _unstarred(t: Any, title: str) -> Any:
    """The catalog hides rude words under stars («Д*******М — НЕТ!»). A name that is the file's under them is the
    file's name: the record is weighed, and filed, under the name written out."""
    if "*" not in t.title:
        return t
    plain = lambda s: " ".join(re.sub(r"[^\w*]+", " ", re.sub(r"\*+", "*", s)).split()).casefold()  # noqa: E731
    mask = "".join(".+?" if part == "*" else re.escape(part) for part in re.split(r"(\*)", plain(t.title)))
    return t.model_copy(update={"title": title}) if re.fullmatch(mask, plain(title)) else t


def _weigh(found: list[Any], artist: str, raw_title: str, album: str | None, duration: int | None, version: str | None,
           cfg: Any) -> tuple[list[tuple[Any, Any]], str]:
    """The records that may be the file's, the likest first, and what they come to. One song stands in the catalog
    several times — a single, its album, the album's new edition: those are not rivals of each other, so the
    likest record is «the one» when no *other song* comes near it."""
    scored = [(t, sc) for t, sc in match_catalog(main_artist(artist), raw_title, [_unstarred(t, raw_title) for t in found],
                                                album=album, duration=duration, version=version)
              if _theirs(t, sc, split_version(raw_title)[0] or raw_title, album, duration, cfg)]
    if not scored:
        return [], "not_found"
    top = scored[0][0]

    def same_song(t: Any) -> bool:
        return (_words(t.title).casefold() == _words(top.title).casefold()
                and bool(t.duration_s and top.duration_s and abs(t.duration_s - top.duration_s) <= SAME_LENGTH_S))

    rivals = [scored[0], *[(t, sc) for t, sc in scored[1:] if not same_song(t)]]
    return scored, classify_scores([sc.total for _, sc in rivals], cfg)


def _theirs(t: Any, sc: Any, title: str, album: str | None, duration: int | None, cfg: Any) -> bool:
    """A record that may be the file's at all: of the file's artist — or, under another name of theirs (an album
    put out as «M00NCHILD»), the same name on the same album over the same length. A song of the same name by
    somebody else is not a record «like» the file: it is another song."""
    if _goes_on(title, t.title):
        return sc.artist >= cfg.artist_min_ratio
    if sc.title < TITLE_FLOOR:
        return False
    # a name only somewhat like the file's, over another length, is another song of the artist's («Не надо» is not
    # «Не знаю»)
    if sc.title < TITLE_SURE and duration and t.duration_s and abs(duration - t.duration_s) > DOUBT_LENGTH_S:
        return False
    if sc.artist >= cfg.artist_min_ratio:
        return True
    same_album = bool(album and t.album_title and " ".join(album.split()).casefold() == " ".join(t.album_title.split()).casefold())
    return same_album and sc.title >= 0.95 and bool(duration and t.duration_s and abs(duration - t.duration_s) <= SAME_LENGTH_S)


def _goes_on(title: str, theirs: str) -> bool:
    """The catalog's name is the file's with something after it: «(prod. by …)», «(feat. …)»."""
    mine = _words(title).casefold()
    return bool(mine) and (_words(theirs).casefold() + " ").startswith(mine + " ")


def _numbers(s: str) -> set[str]:
    return set(re.findall(r"\d+(?:[.,]\d+)?", s))


def _words(s: str) -> str:
    """The words of a name, as the catalog's search takes them: letters, digits and «$» (May Wave$)."""
    return " ".join(re.sub(r"[^\w$]+", " ", s, flags=re.UNICODE).split())


def _mmss(s: int | float | None) -> str:
    return f"{int(s) // 60}:{int(s) % 60:02d}" if s else "?"


async def of_file(tags: dict[str, Any], file_name: str, duration_s: float | None) -> dict[str, Any]:
    """{state: "found" | "doubt" | "none", why, meta}: `meta` — the record as a download carries it
    (`jobs.downloads.meta_from_catalog`), with its title and artist line."""
    artist, raw_title = names_of(tags, file_name)
    if not artist or not raw_title or svc.deezer is None:
        return {"state": "none", "why": None, "meta": None}
    title, version = split_version(raw_title)
    duration = round(duration_s) if duration_s else None
    # The catalog's search takes plain words, and is asked several ways, each only if the one before it did not
    # settle the matter: the first artist with the name; the whole line of artists; the name spelt in Latin letters
    # (the catalog writes many Russian names so: «Nikto Ne Nuzhen»); the name alone (the catalog may spell the
    # artist otherwise: «ЛСП» for the file's «LSP»). What it gives is weighed together — a record is the file's by
    # its artist, name and length, however it was found. Signs go out of the words: an apostrophe finds nothing.
    wanted, first = _words(title or raw_title), _words(main_artist(artist))
    asks = [f"{first} {wanted}", f"{_words(artist)} {wanted}"]
    if has_cyrillic(wanted):
        asks.append(f"{first} {to_latin(wanted)}")
    asks.append(wanted)
    album = None if single_album(tags.get("album"), raw_title) else tags.get("album")
    cfg = get_settings().cfg.matching
    found, seen, failed, scored, verdict = [], set(), None, [], "not_found"
    for ask in dict.fromkeys(a for a in asks if a.strip()):
        try:
            got, _ = await svc.deezer.search_track_page(ask, 0, 25 if ask == wanted else 10)
        except Exception as e:
            log.info("recognize: catalog search failed for %r: %r", ask, e)
            failed = e
            continue
        new = [t for t in got if t.ref not in seen]
        if not new:
            continue
        seen.update(t.ref for t in new)
        found.extend(new)
        scored, verdict = _weigh(found, artist, raw_title, album, duration, version, cfg)
        if verdict == "auto":
            break
    if verdict != "auto":
        # the search did not settle it — it misses a good deal of what the catalog has. The artist's own releases
        # are gone through then: the song is looked for among everything they put out
        more = [t for t in await _released_by(artist) if t.ref not in seen]
        if more:
            found.extend(more)
            scored, verdict = _weigh(found, artist, raw_title, album, duration, version, cfg)
    if verdict == "not_found":
        return {"state": "none", "why": "каталог не ответил" if failed and not found else None, "meta": None}
    top = scored[0][0]
    why: str | None = None
    close = bool(duration and top.duration_s and abs(duration - top.duration_s) <= SAME_LENGTH_S)
    # a name that only goes on in the catalog — «(prod. by …)», «(feat. …)» — over the same length is the same song
    longer = _goes_on(title or raw_title, top.title)
    if verdict != "auto" and not (close and longer and scored[0][1].artist >= cfg.artist_min_ratio):
        why = "названия совпали не полностью"
    # «Отдай кота 2.0» is not «Отдай кота»: the numbers of a name are part of what it names
    if _numbers(raw_title) != _numbers(top.title):
        why = "в названии другой номер"
    theirs = split_version(top.title)[1]
    if version_kind(version) != version_kind(theirs):
        why = f"в файле версия «{version}», в каталоге — обычная запись" if version else f"в каталоге версия «{theirs}», в файле — обычная запись"
    elif duration and top.duration_s and abs(duration - top.duration_s) > DOUBT_LENGTH_S:
        why = f"длительность другая: {_mmss(duration)} в файле, {_mmss(top.duration_s)} в каталоге"
    return {"state": "doubt" if why else "found", "why": why, "meta": await meta_of(top)}


async def of_ref(ref: str) -> dict[str, Any]:
    """The record the listener picked by hand: it is the file's, no doubt about it."""
    src, _, ident = ref.partition(":")
    if src != "dz" or not ident or svc.deezer is None:
        raise ValueError("Каталог не знает такой записи")
    return {"state": "found", "why": None, "meta": await meta_of(await svc.deezer.get_track(ident)), "by_hand": True}


async def meta_of(t: Any) -> dict[str, Any]:
    from app.jobs.downloads import complete_meta, meta_from_catalog

    meta = await complete_meta(meta_from_catalog(t))
    meta["title"], meta["artist"] = t.title, t.artist
    meta.setdefault("artists", t.artists or [t.artist])
    return meta
