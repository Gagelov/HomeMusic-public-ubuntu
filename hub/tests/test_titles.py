"""A track's name without the credits written into it."""

from __future__ import annotations

import pytest

from tests.test_flow import download_one, drain_jobs
from tests.test_flow import env as env  # the fixture
from tests.test_flow import src_mp3 as src_mp3  # its file


@pytest.mark.parametrize(("raw", "name", "guests", "producers"), [
    ("Marmalade (feat. Lil Yachty)", "Marmalade", ["Lil Yachty"], []),
    ("Marmalade [ft. Lil Yachty]", "Marmalade", ["Lil Yachty"], []),
    ("Song feat. A, B & C", "Song", ["A", "B", "C"], []),
    ("Song ft. A (Remix)", "Song (Remix)", ["A"], []),
    ("Song (Remix) (feat. A)", "Song (Remix)", ["A"], []),
    ("Трек (prod. by Мастер)", "Трек", [], ["Мастер"]),
    ("Трек (feat. Гость) [prod. X & Y]", "Трек", ["Гость"], ["X", "Y"]),
    ("Трек - prod. by X", "Трек", [], ["X"]),
    ("Трек feat. A prod. by X", "Трек", ["A"], ["X"]),
    ("Песня (прод. Битмейкер)", "Песня", [], ["Битмейкер"]),
    ("Produced By Love", "Produced By Love", [], []),  # the words of a name are the name
    ("Product", "Product", [], []),
    ("5 ft tall", "5 ft tall", [], []),
    ("Dance with Me", "Dance with Me", [], []),
    ("Stay (with Justin Bieber)", "Stay (with Justin Bieber)", [], []),  # «with» is not read
    ("Song (Live)", "Song (Live)", [], []),
    ("(feat. A)", "(feat. A)", [], []),  # nothing but a credit: left as it is
])
def test_a_name_is_cleaned_of_its_credits(raw, name, guests, producers):
    from app.library import titles

    assert titles.clean(raw) == (name, guests, producers)


def test_guests_join_the_artists_once():
    from app.library import titles

    assert titles.with_guests("Macklemore", ["Macklemore"], ["Lil Yachty"]) == ("Macklemore, Lil Yachty", ["Macklemore", "Lil Yachty"])
    assert titles.with_guests("Macklemore, Lil Yachty", [], ["lil yachty"]) == ("Macklemore, Lil Yachty", [])


async def test_the_library_is_gone_through_once(env):
    """The tracks the library had are cleaned by a job: the rows, the files' tags, the artists, each change written down."""
    from sqlalchemy import select

    from app.db import session_scope
    from app.jobs.queue import enqueue
    from app.library import tagger, titles
    from app.library.importer import library_abs
    from app.models import Track, TrackFile

    c = env["client"]
    await download_one(c, {"artist": "Кино", "title": "Группа крови"})
    async with session_scope() as s:
        t = (await s.execute(select(Track).join(TrackFile, TrackFile.track_id == Track.id))).scalars().first()
        t.title = "Группа крови (feat. Гость) [prod. by Битмейкер]"  # as it came from somewhere, before this
        tid = t.id
    async with session_scope() as s:
        (row,) = await titles.pending(s)
        assert (row["was"], row["title"], row["artist"], row["producer"]) == ("Группа крови (feat. Гость) [prod. by Битмейкер]", "Группа крови", "Кино, Гость", "Битмейкер")
        await enqueue(s, "titles_clean", {"user_id": None})
    await drain_jobs()
    async with session_scope() as s:
        t = await s.get(Track, tid)
        f = (await s.execute(select(TrackFile).where(TrackFile.track_id == tid))).scalars().first()
        assert (t.title, t.artist, t.producer) == ("Группа крови", "Кино, Гость", "Битмейкер")
        tags = tagger.read_tag_fields(library_abs(f.path))
        assert (tags["title"], tags["artist"], tags.get("producer")) == ("Группа крови", "Кино, Гость", "Битмейкер"), tags
        assert await titles.pending(s) == []
    hist = (await c.get(f"/api/library/tracks/{tid}/edits")).json()
    assert any(h["changes"].get("title") == ["Группа крови (feat. Гость) [prod. by Битмейкер]", "Группа крови"] for h in hist), hist
    info = (await c.get("/api/library/track-edit", params={"track_id": tid})).json()
    assert info["producer"] == "Битмейкер"

    # a name a listener wrote by hand is what they meant: it is not cleaned
    r = await c.patch(f"/api/library/tracks/{tid}", json={"title": "Группа крови (feat. Гость)"})
    assert r.status_code == 200, r.text
    async with session_scope() as s:
        assert await titles.pending(s) == []
