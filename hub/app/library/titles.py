"""A track's name is its name: who else is on it, and who made the beat, are not part of it.

Catalogs and files write credits into titles — «Marmalade (feat. Lil Yachty)», «Трек (prod. by X)». A guest is an
artist of the track and belongs with its artists, where everyone credited is shown anyway; a producer is neither
the name nor a performer, and has a place of their own (`Track.producer`, the file's PRODUCER tag). So where a
name comes into the Hub — a file brought in, a song met in a catalog, a list a catalog answers — it is cleaned
(`clean`): the guests go to the artists unless they are there already, the producer to their field, and the name
is what is left. What tells one recording from another — Remix, Live, Deluxe, Remastered — is the name's own and
stays. Only `feat.`, `ft.`, `featuring` and `prod.`, `prod. by`, `produced by`, «прод.» are read: a «with» is too
often a word of the name itself.

A name a listener wrote by hand is never cleaned: it is what they meant. The tracks the library had before this are
gone through once (`pending`, `apply` — a job), the files' tags with them.
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.library.credits import split_artists
from app.matching.normalize import fingerprint
from app.models import Edit, Track

_GUEST = r"(?:feat\.?|ft\.?|featuring)"
_PROD = r"(?:prod\.?(?:\s+by)?|produced\s+by|прод\.?)"
# in brackets, anywhere in the name: «(feat. X)», «[prod. by Y]»
_IN_BRACKETS = re.compile(rf"\s*[\(\[]\s*(?:(?P<g>{_GUEST})|(?P<p>{_PROD}))\s+(?P<names>[^\)\]]+?)\s*[\)\]]", re.IGNORECASE)
# bare, after the name and before any bracket: «Song feat. X», «Song - prod. by Y (Remix)». Bare, «ft» and «prod»
# need their dot (or «by»): without it they may be words of the name
_BARE = re.compile(
    r"\s+(?:[-–—]\s*)?(?:(?P<g>feat\.?|ft\.|featuring)|(?P<p>prod\.(?:\s+by)?|prod\s+by|produced\s+by|прод\.))\s+(?P<names>[^()\[\]]+?)(?=\s*[\(\[]|\s+(?:[-–—]\s*)?(?:feat\.?|ft\.|featuring|prod\.|prod\s+by|produced\s+by|прод\.)\s|\s*$)",
    re.IGNORECASE)


def _key(name: str) -> str:
    return " ".join(name.split()).casefold()


def _people(text: str) -> list[str]:
    """The names of a credit: by commas (a comma inside a name is kept by `split_artists`), and by «&»."""
    out: list[str] = []
    for part in split_artists(text):
        for name in re.split(r"\s+&\s+", part):
            name = name.strip(" .")
            if name and _key(name) not in {_key(x) for x in out}:
                out.append(name)
    return out


def clean(title: str | None) -> tuple[str, list[str], list[str]]:
    """A name without the credits written into it: (the name, the guests, the producers). A name that is nothing
    but a credit is left as it is."""
    raw = " ".join((title or "").split())
    guests: list[str] = []
    producers: list[str] = []

    def take(m: re.Match[str]) -> str:
        (guests if m.group("g") else producers).extend(_people(m.group("names")))
        return ""

    name = _IN_BRACKETS.sub(take, raw)
    while True:  # a guest and a producer may follow one another
        cut = _BARE.sub(take, name, count=1)
        if cut == name:
            break
        name = cut
    name = " ".join(name.split()).strip(" -–—")
    if not name:
        return raw, [], []

    def once(names: list[str]) -> list[str]:
        out: list[str] = []
        for n in names:
            if _key(n) not in {_key(x) for x in out}:
                out.append(n)
        return out

    return name, once(guests), once(producers)


def with_guests(line: str | None, artists: list[str] | None, guests: list[str]) -> tuple[str, list[str]]:
    """The artists of a track with the guests its name credited: each added once, after the others, unless they
    are among them already. Returns (the line, the list)."""
    parts = split_artists(line)
    names = list(artists or [])
    have = {_key(x) for x in (*parts, *names)}
    text = (line or "").strip()
    for g in guests:
        if _key(g) in have:
            continue
        have.add(_key(g))
        text = f"{text}, {g}" if text else g
        if names:
            names.append(g)
    return text, names


def put_right(o: Any) -> None:
    """What a catalog says of a track, with its name cleaned: the guests among its artists, in their places."""
    name, guests, _ = clean(getattr(o, "title", None))
    if name == o.title:
        return
    o.title = name
    names = list(getattr(o, "artists", None) or [])
    have = {_key(x) for x in (*names, getattr(o, "artist", "") or "")}
    missing = [g for g in guests if _key(g) not in have]
    if missing and names:
        o.artists = [*names, *missing]
        refs = getattr(o, "artist_refs", None)
        if refs:
            o.artist_refs = [*refs, *([None] * (len(o.artists) - len(refs)))]


async def pending(s: AsyncSession) -> list[dict[str, Any]]:
    """The library's tracks whose names carry a credit: what each would be called, who would be added to its
    artists, who made its beat. The names a listener put right by hand are not among them."""
    out: list[dict[str, Any]] = []
    for t in (await s.execute(select(Track).where(Track.renamed_at.is_(None)).order_by(Track.id))).scalars():
        name, guests, producers = clean(t.title)
        if name == t.title:
            continue
        line, _ = with_guests(t.artist, None, guests)
        out.append({"track_id": t.id, "was": t.title, "title": name, "artist_was": t.artist, "artist": line,
                    "producer": ", ".join(producers) or None})
    return out


async def apply(s: AsyncSession, user_id: int | None = None) -> int:
    """Clean the names of the library's tracks (`pending`): the rows and the files' tags, each change written
    down. Returns how many tracks changed. It may be run again: what is clean already is left."""
    from app.library import artists, editor

    n = 0
    for row in await pending(s):
        t = await s.get(Track, row["track_id"])
        if t is None:
            continue
        changes: dict[str, list[Any]] = {"title": [t.title, row["title"]]}
        fields: dict[str, Any] = {"title": row["title"]}
        if row["artist"] != t.artist:
            changes["artist"] = [t.artist, row["artist"]]
            fields["artist"] = row["artist"]
        if row["producer"] and not t.producer:  # into the row and the file's tag with the names
            changes["producer"] = [None, row["producer"]]
            fields["producer"] = row["producer"]
        await editor.update_track(s, t, **fields)
        t.fingerprint = fingerprint(t.artist, t.title)
        if "artist" in fields:
            await artists.credit_track(s, t)
        s.add(Edit(target_type="track", target_id=t.id, user_id=user_id, changes_json=changes))
        n += 1
    await s.flush()
    return n
