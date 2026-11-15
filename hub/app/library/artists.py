"""Who an artist is, however the name is written — and what else a song is called.

An artist has one name here, for everyone, and any number of other spellings («ЛСП» is «LSP» to a catalog). The
library is written in the one name: a track that comes under a spelling is filed under the artist's name, its file
tagged so, and when the name changes (a spelling is made the name, two artists turn out to be one) every track and
album of theirs is rewritten (`rewrite`, a job). So the search, a shared link, Navidrome and the files agree.

Spellings that differ only in the letters' case are one artist by themselves. Others are joined by a listener:
the Hub only says who looks like the same one (`suggestions`: the names read alike once in Latin letters), and
remembers «это другой». What a catalog calls its own artist (`ArtistRef`) leads to the artist here.

A side project is not a spelling: «M00NCHILD» has releases of its own and stays an artist of its own — the two are
only linked (`ArtistLink`), each named on the other's page.

A track, too, has one name and others it is known by (`TrackName`): the name it had before it was put right, what
its file called it, one a listener adds («Марафоны» for «Спорт»). The search reads them all (`found`).
"""

from __future__ import annotations

from typing import Any, Iterable

from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.library.credits import split_artists
from app.matching.normalize import _clean, _prep, fingerprint, to_latin
from app.models import Album, Artist, ArtistApart, ArtistLink, ArtistName, ArtistRef, Edit, Track, TrackFile, TrackName


class Taken(Exception):
    """The spelling is another artist's: the two may be one (`artist_id`, `name`)."""

    def __init__(self, artist_id: int, name: str):
        super().__init__(name)
        self.artist_id, self.name = artist_id, name


def key(name: str | None) -> str:
    """What makes two spellings the same one: the letters' case and the spaces do not."""
    return " ".join((name or "").split()).casefold()


def fold(text: str | None) -> str:
    """A name as it reads in Latin letters, without punctuation: «Деньги не проблема» and «Den'gi ne problema»,
    «ЛСП» and «LSP» fold to the same."""
    return to_latin(_clean(_prep(text)))


def _pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


# ---------------------------------------------------------------- artists


async def known(s: AsyncSession, name: str | None) -> Artist | None:
    k = key(name)
    if not k:
        return None
    return (await s.execute(select(Artist).join(ArtistName, ArtistName.artist_id == Artist.id).where(ArtistName.key == k))).scalar_one_or_none()


async def resolve(s: AsyncSession, name: str, source: str = "library") -> Artist:
    """The artist of this spelling; one nobody was called yet is a new artist of that name."""
    a = await known(s, name)
    if a is None:
        a = Artist(name=" ".join(name.split()))
        s.add(a)
        await s.flush()
        s.add(ArtistName(artist_id=a.id, name=a.name, key=key(name), source=source))
        await s.flush()
    return a


async def mapping(s: AsyncSession, names: Iterable[str | None]) -> dict[str, str]:
    """Spelling (as `key`) → the artist's name, for the spellings that are not the name itself. Nothing is made."""
    keys = {key(n) for n in names if n}
    if not keys:
        return {}
    rows = (await s.execute(select(ArtistName.key, Artist.name).join(Artist, Artist.id == ArtistName.artist_id).where(ArtistName.key.in_(keys)))).all()
    return {k: main for k, main in rows if key(main) != k}


def _in_names(parts: list[str], names: dict[str, str]) -> list[str]:
    out: list[str] = []
    for p in parts:
        n = names.get(key(p), p)
        if key(n) not in {key(x) for x in out}:
            out.append(n)
    return out


async def line(s: AsyncSession, text: str | None, source: str = "library") -> str:
    """A line of artists in the artists' names; every one of them is known from now on."""
    parts = split_artists(text)
    if not parts:
        return (text or "").strip()
    theirs = {key(p): (await resolve(s, p, source)).name for p in parts}
    if all(theirs[key(p)] == p for p in parts):
        return (text or "").strip()  # nothing to put right: the line stays as it was written («A feat. B»)
    return ", ".join(_in_names(parts, theirs))


async def names(s: AsyncSession, parts: Iterable[str], source: str = "library") -> list[str]:
    parts = [p for p in parts if p and p.strip()]
    return _in_names(parts, {key(p): (await resolve(s, p, source)).name for p in parts})


def put_right(o: Any, names_: dict[str, str]) -> None:
    """What a catalog says of a track or an album, in the artists' names here."""
    if not names_:
        return
    for field in ("artist", "album_artist"):
        v = getattr(o, field, None)
        if isinstance(v, str) and key(v) in names_:
            setattr(o, field, names_[key(v)])
    v = getattr(o, "artists", None)
    if isinstance(v, list) and any(isinstance(a, str) and key(a) in names_ for a in v):
        o.artists = [names_.get(key(a), a) if isinstance(a, str) else a for a in v]


async def shown(s: AsyncSession, found: list[Any]) -> list[Any]:
    """A catalog's artists (each with a `ref` and a `name`) under the names they have here: by what the catalog
    calls its own artist, else by the spelling. The ones the Hub calls the same are returned as they came."""
    if not found:
        return found
    by_ref = dict((await s.execute(
        select(ArtistRef.ref, Artist.name).join(Artist, Artist.id == ArtistRef.artist_id)
        .where(ArtistRef.ref.in_([a.ref for a in found if getattr(a, "ref", None)])))).all())
    spelt = await mapping(s, [a.name for a in found])
    out = []
    for a in found:
        name = by_ref.get(getattr(a, "ref", None)) or spelt.get(key(a.name))
        out.append(a.model_copy(update={"name": name}) if name and name != a.name else a)
    return out


async def seed(s: AsyncSession) -> int:
    """Every artist the library names is an artist here (run when the Hub starts: the names are few)."""
    have = set((await s.execute(select(ArtistName.key))).scalars())
    seen: dict[str, str] = {}
    for a, aa in (await s.execute(select(Track.artist, Track.album_artist))).all():
        for n in split_artists(a) + split_artists(aa):
            seen.setdefault(key(n), n)
    for (aa,) in (await s.execute(select(Album.album_artist))).all():
        for n in split_artists(aa):
            seen.setdefault(key(n), n)
    new = [n for k, n in seen.items() if k and k not in have]
    for n in new:
        await resolve(s, n)
    return len(new)


async def of_ref(s: AsyncSession, ref: str | None, name: str | None) -> Artist | None:
    """The artist a catalog's page is of: by what the catalog calls its own (`ref`), else by the name — and the
    catalog's own is remembered to be theirs."""
    a = None
    if ref:
        a = (await s.execute(select(Artist).join(ArtistRef, ArtistRef.artist_id == Artist.id).where(ArtistRef.ref == ref))).scalar_one_or_none()
    if a is None and name and name.strip():
        a = await resolve(s, name, "catalog")
        if ref:
            s.add(ArtistRef(ref=ref, artist_id=a.id))
            await s.flush()
    return a


async def _linked(s: AsyncSession, artist_id: int) -> set[int]:
    """The other projects of who the artist is: everyone linked to them, straight or through another project —
    the projects of one person are one group, whichever two of them were named together."""
    near: dict[int, set[int]] = {}
    for low, high in (await s.execute(select(ArtistLink.low_id, ArtistLink.high_id))).all():
        near.setdefault(low, set()).add(high)
        near.setdefault(high, set()).add(low)
    seen, todo = {artist_id}, [artist_id]
    while todo:
        for i in near.get(todo.pop(), ()):
            if i not in seen:
                seen.add(i)
                todo.append(i)
    return seen - {artist_id}


async def _apart(s: AsyncSession, artist_id: int) -> set[int]:
    rows = (await s.execute(select(ArtistApart.low_id, ArtistApart.high_id).where(or_(ArtistApart.low_id == artist_id, ArtistApart.high_id == artist_id)))).all()
    return {x for r in rows for x in r if x != artist_id}


async def suggestions(s: AsyncSession, artist: Artist) -> list[Artist]:
    """Artists that look like this one: a name of theirs reads the same in Latin letters. Not the ones linked as
    projects, nor those a listener said are somebody else."""
    rows = (await s.execute(select(ArtistName.artist_id, ArtistName.name))).all()
    mine = {fold(n) for i, n in rows if i == artist.id} - {""}
    skip = {artist.id} | await _linked(s, artist.id) | await _apart(s, artist.id)
    ids = {i for i, n in rows if i not in skip and fold(n) in mine}
    return list((await s.execute(select(Artist).where(Artist.id.in_(ids)).order_by(Artist.name))).scalars()) if ids else []


async def _picture(s: AsyncSession, artist: Artist, ref: str | None) -> str | None:
    """A small picture of the artist: the catalog's, else the cover of an album of theirs here."""
    from app.catalog.models import split_ref
    from app.services import svc

    if ref and svc.deezer is not None:
        try:
            src, id_ = split_ref(ref)
            if src == "dz":
                a = await svc.deezer.get_artist(id_)
                if a.picture_small_url or a.picture_url:
                    return a.picture_small_url or a.picture_url
        except Exception:  # the catalog is away, or knows the artist no more: the library's picture then
            pass
    album_id = (await s.execute(select(Album.id).where(Album.album_artist == artist.name, Album.cover_path.is_not(None)).limit(1))).scalar_one_or_none()
    return f"/api/library/albums/{album_id}/cover" if album_id else None


async def card(s: AsyncSession, artist: Artist) -> dict[str, Any]:
    """What an artist's page says of the name: the spellings, the other projects, who looks like the same one."""
    rows = (await s.execute(select(ArtistName).where(ArtistName.artist_id == artist.id).order_by(ArtistName.id))).scalars().all()
    main = key(artist.name)
    linked = await _linked(s, artist.id)
    projects = list((await s.execute(select(Artist).where(Artist.id.in_(linked)).order_by(Artist.name))).scalars()) if linked else []
    refs = dict((await s.execute(select(ArtistRef.artist_id, ArtistRef.ref).where(ArtistRef.artist_id.in_([p.id for p in projects])))).all()) if projects else {}
    spelt = {p.id: [] for p in projects}
    if projects:
        for i, n in (await s.execute(select(ArtistName.artist_id, ArtistName.name).where(ArtistName.artist_id.in_(list(spelt))).order_by(ArtistName.id))).all():
            spelt[i].append(n)
    return {
        "id": artist.id, "name": artist.name,
        "names": [{"id": r.id, "name": r.name, "source": r.source, "main": r.key == main} for r in sorted(rows, key=lambda r: r.key != main)],
        "projects": [{"id": p.id, "name": p.name, "ref": refs.get(p.id), "also": [n for n in spelt[p.id] if key(n) != key(p.name)],
                      "picture_url": await _picture(s, p, refs.get(p.id))} for p in projects],
        "suggestions": [{"id": a.id, "name": a.name} for a in await suggestions(s, artist)],
    }


async def find(s: AsyncSession, q: str, limit: int = 12) -> list[dict[str, Any]]:
    """Artists by any spelling, read in Latin letters too."""
    want = fold(q)
    if not want:
        return []
    rows = (await s.execute(select(ArtistName.artist_id, ArtistName.name, Artist.name).join(Artist, Artist.id == ArtistName.artist_id))).all()
    out: dict[int, dict[str, Any]] = {}
    for i, n, main in sorted(rows, key=lambda r: (not fold(r[1]).startswith(want), len(r[1]))):
        if want in fold(n) and i not in out:
            out[i] = {"id": i, "name": main}
    return list(out.values())[:limit]


def _journal(s: AsyncSession, user_id: int | None, artist_id: int, changes: dict[str, list[Any]]) -> None:
    s.add(Edit(target_type="artist", target_id=artist_id, user_id=user_id, changes_json=changes))


async def add_name(s: AsyncSession, user_id: int | None, artist: Artist, name: str) -> ArtistName:
    """One more spelling of the artist. `Taken`: it is somebody else's here — the two may be joined."""
    name = " ".join(name.split())
    if not name:
        raise ValueError("Пустое написание")
    row = (await s.execute(select(ArtistName).where(ArtistName.key == key(name)))).scalar_one_or_none()
    if row is not None:
        if row.artist_id == artist.id:
            return row
        other = await s.get(Artist, row.artist_id)
        raise Taken(row.artist_id, other.name if other else name)
    row = ArtistName(artist_id=artist.id, name=name, key=key(name), source="manual")
    s.add(row)
    _journal(s, user_id, artist.id, {"name": [None, name]})
    await s.flush()
    return row


async def set_main(s: AsyncSession, user_id: int | None, artist: Artist, name_id: int) -> bool:
    """A spelling becomes the artist's name; the library is then rewritten in it (the caller queues `rewrite`)."""
    row = await s.get(ArtistName, name_id)
    if row is None or row.artist_id != artist.id:
        raise ValueError("У исполнителя нет такого написания")
    if row.name == artist.name:
        return False
    _journal(s, user_id, artist.id, {"main": [artist.name, row.name]})
    artist.name = row.name
    await s.flush()
    return True


async def drop_name(s: AsyncSession, user_id: int | None, artist: Artist, name_id: int) -> Artist | None:
    """A spelling leaves the artist. One a listener wrote in is forgotten; one that came with music becomes an
    artist of its own again (returned) — what comes under it from now on is theirs. The artist's own name stays."""
    row = await s.get(ArtistName, name_id)
    if row is None or row.artist_id != artist.id:
        raise ValueError("У исполнителя нет такого написания")
    if row.key == key(artist.name):
        raise ValueError("Это основное имя: сначала сделайте основным другое")
    _journal(s, user_id, artist.id, {"name": [row.name, None]})
    if row.source == "manual":
        await s.delete(row)
        await s.flush()
        return None
    own = Artist(name=row.name)
    s.add(own)
    await s.flush()
    row.artist_id = own.id
    s.add(ArtistApart(low_id=_pair(artist.id, own.id)[0], high_id=_pair(artist.id, own.id)[1]))
    await s.flush()
    return own


async def merge(s: AsyncSession, user_id: int | None, into: Artist, other: Artist) -> None:
    """Two artists are one: `other`'s spellings, catalog pages and projects are `into`'s (the caller queues `rewrite`)."""
    if into.id == other.id:
        return
    for row in (await s.execute(select(ArtistName).where(ArtistName.artist_id == other.id))).scalars():
        row.artist_id = into.id
    for row in (await s.execute(select(ArtistRef).where(ArtistRef.artist_id == other.id))).scalars():
        row.artist_id = into.id
    theirs = (await _linked(s, other.id)) - {into.id}
    mine = await _linked(s, into.id)
    await s.execute(delete(ArtistLink).where(or_(ArtistLink.low_id == other.id, ArtistLink.high_id == other.id)))
    await s.execute(delete(ArtistApart).where(or_(ArtistApart.low_id == other.id, ArtistApart.high_id == other.id)))
    for i in theirs - mine:
        s.add(ArtistLink(low_id=_pair(into.id, i)[0], high_id=_pair(into.id, i)[1]))
    _journal(s, user_id, into.id, {"merged": [other.name, into.name]})
    await s.flush()
    await s.delete(other)
    await s.flush()


async def link(s: AsyncSession, user_id: int | None, a: Artist, b: Artist, on: bool = True) -> None:
    """`b` is another project of who `a` is — and so of every project of theirs. Or is not any more: `b` leaves
    the group, and the others stay each other's."""
    if a.id == b.id:
        raise ValueError("Это тот же исполнитель")
    group = await _linked(s, a.id)
    if on and b.id not in group:
        low, high = _pair(a.id, b.id)
        s.add(ArtistLink(low_id=low, high_id=high))
        _journal(s, user_id, a.id, {"project": [None, b.name]})
    elif not on and b.id in group:
        await s.execute(delete(ArtistLink).where(or_(ArtistLink.low_id == b.id, ArtistLink.high_id == b.id)))
        await s.flush()
        rest = sorted(group - {b.id})  # they were perhaps linked only through the one that left
        still = await _linked(s, a.id)
        for i in rest:
            if i not in still:
                low, high = _pair(a.id, i)
                s.add(ArtistLink(low_id=low, high_id=high))
        _journal(s, user_id, a.id, {"project": [b.name, None]})
    await s.flush()


async def apart(s: AsyncSession, a: Artist, b: Artist) -> None:
    """«Это другой»: the two are not offered to be joined again."""
    low, high = _pair(a.id, b.id)
    if a.id != b.id and (await s.execute(select(ArtistApart).where(ArtistApart.low_id == low, ArtistApart.high_id == high))).scalar_one_or_none() is None:
        s.add(ArtistApart(low_id=low, high_id=high))
        await s.flush()


async def rewrite(s: AsyncSession, artist: Artist, user_id: int | None = None) -> int:
    """Write the library in the artist's name: every track and album that names them by another spelling — the
    rows and the files' tags. An album that becomes the same as one the artist has is joined with it. Returns how
    many tracks and albums changed. It may be run again: what is already right is left."""
    from app.library import editor
    from app.library.importer import find_album

    rows = (await s.execute(select(ArtistName.name).where(ArtistName.artist_id == artist.id))).scalars().all()
    spelt = {key(n): artist.name for n in rows if key(n) != key(artist.name)}
    if not spelt:
        return 0

    def right(text: str | None) -> str | None:
        parts = split_artists(text)
        if not any(key(p) in spelt for p in parts):
            return None
        return ", ".join(_in_names(parts, spelt))

    changed = 0
    for album in (await s.execute(select(Album))).scalars().all():
        new = right(album.album_artist)
        if new is None or new == album.album_artist:
            continue
        same = await find_album(s, title=album.title, album_artist=new, deezer_album_id=album.deezer_album_id)
        s.add(Edit(target_type="album", target_id=album.id, user_id=user_id, changes_json={"album_artist": [album.album_artist, new]}))
        if same is not None and same.id != album.id:
            await editor.merge_albums(s, [album.id], same)
        else:
            await editor.update_album(s, album, album_artist=new)
        changed += 1
    for track in (await s.execute(select(Track))).scalars().all():
        new = right(track.artist)
        if new is not None and new != track.artist:
            s.add(Edit(target_type="track", target_id=track.id, user_id=user_id, changes_json={"artist": [track.artist, new]}))
            await editor.update_track(s, track, artist=new)
            track.fingerprint = fingerprint(track.artist, track.title)
            changed += 1
        if track.album_id is None:
            own = right(track.album_artist)
            if own is not None:
                track.album_artist = own
    await s.flush()
    return changed


# ---------------------------------------------------------------- what else a track is called


async def titles(s: AsyncSession, track: Track) -> list[dict[str, Any]]:
    """The other names of a track: the ones kept, and what the catalog calls it where that is not its name."""
    rows = (await s.execute(select(TrackName).where(TrackName.track_id == track.id).order_by(TrackName.id))).scalars().all()
    out = [{"id": r.id, "name": r.name, "source": r.source} for r in rows if r.key != key(track.title)]
    cat = (track.catalog or {}).get("title")
    if cat and key(cat) != key(track.title) and key(cat) not in {key(o["name"]) for o in out}:
        out.append({"id": None, "name": cat, "source": "catalog"})
    return out


async def add_title(s: AsyncSession, track: Track, name: str | None, source: str = "manual") -> bool:
    name = " ".join((name or "").split())
    if not name or key(name) == key(track.title):
        return False
    if (await s.execute(select(TrackName.id).where(TrackName.track_id == track.id, TrackName.key == key(name)))).first():
        return False
    s.add(TrackName(track_id=track.id, name=name, key=key(name), source=source))
    await s.flush()
    return True


async def drop_title(s: AsyncSession, track: Track, name_id: int) -> None:
    await s.execute(delete(TrackName).where(TrackName.track_id == track.id, TrackName.id == name_id))


async def renamed(s: AsyncSession, track: Track, was: str | None) -> None:
    """The track was given another name: the one it had is kept among the others, the new one is not one of them."""
    await s.execute(delete(TrackName).where(TrackName.track_id == track.id, TrackName.key == key(track.title)))
    await add_title(s, track, was, "renamed")


# ---------------------------------------------------------------- the library's search


async def found(s: AsyncSession, q: str, limit: int = 20) -> list[tuple[Track, list[str]]]:
    """The library's songs a query finds — tracks that have a file — by a track's name and its other names, its
    artists in every spelling, its album; Cyrillic and Latin read as one. With each: the other names and spellings
    it was found by (none: by what the row shows)."""
    words = fold(q).split()
    if not words:
        return []
    other: dict[int, list[str]] = {}
    for tid, n in (await s.execute(select(TrackName.track_id, TrackName.name))).all():
        other.setdefault(tid, []).append(n)
    spelt: dict[str, list[str]] = {}  # an artist's name (as key) -> the other spellings
    by_artist: dict[int, list[str]] = {}
    mains: dict[int, str] = dict((await s.execute(select(Artist.id, Artist.name))).all())
    for aid, n in (await s.execute(select(ArtistName.artist_id, ArtistName.name))).all():
        by_artist.setdefault(aid, []).append(n)
    for aid, all_names in by_artist.items():
        main = mains.get(aid)
        if main:
            spelt[key(main)] = [n for n in all_names if key(n) != key(main)]
    has_file = select(TrackFile.id).where(TrackFile.track_id == Track.id).exists()
    hits: list[tuple[int, Track, list[str]]] = []
    for t in (await s.execute(select(Track).where(has_file))).scalars():
        shown = fold(f"{t.artist} {t.title} {t.album or ''}")
        also = [*other.get(t.id, []), *([(t.catalog or {}).get("title")] if (t.catalog or {}).get("title") else [])]
        for a in split_artists(t.artist):
            also += spelt.get(key(a), [])
        folded = [(n, fold(n)) for n in also]
        if not all(w in shown or any(w in f for _, f in folded) for w in words):
            continue
        by = []
        for n, f in folded:
            if any(w in f and w not in shown for w in words) and n not in by:
                by.append(n)
        # a name that begins with the query before one that only has it inside; what the row shows before the rest
        hits.append((int(bool(by)) * 2 + int(not fold(t.title).startswith(words[0])), t, by))
    hits.sort(key=lambda h: h[0])
    return [(t, by) for _, t, by in hits[:limit]]
