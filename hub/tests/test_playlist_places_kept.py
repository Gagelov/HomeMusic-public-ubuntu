"""A playlist brought from another service is whole: a row that has no track yet has its place kept, the track takes
the place once the row has one, and a row left out gives the place up."""

import pytest
from sqlalchemy import select

from app import db, playlists
from app.favorites import project_liked
from app.imports import apply
from app.imports.core import places_out
from app.matching.normalize import fingerprint
from app.models import Import, ImportCollection, ImportItem, PlaylistItem, User
from app.security import encrypt
from tests.support import filed_track


@pytest.fixture
async def env(hub_env):
    db.init_engine()
    try:
        async with db.session_scope() as s:
            user = User(nd_username="qa", nd_password_enc=encrypt("qa-password"))
            s.add(user)
            await s.flush()
            imp = Import(user_id=user.id, source="spotify", method="csv", mode="full", status="running")
            s.add(imp)
            await s.flush()
            colls = {}
            for kind in ("playlist", "likes"):
                colls[kind] = ImportCollection(import_id=imp.id, kind=kind, external_id=kind, title="Карантин", selected=True)
                s.add(colls[kind])
            tracks = [filed_track(path=f"{n}.mp3", artist="A", title=n, fingerprint=fingerprint("A", n)) for n in ("a", "c", "x")]
            s.add_all(tracks)
            await s.flush()
            a, c, x = (t.id for t in tracks)
            for kind, coll in colls.items():
                for position, (title, track_id, status) in enumerate([("a", a, "done"), ("b", None, "not_found"), ("c", c, "done")]):
                    s.add(ImportItem(import_id=imp.id, collection_id=coll.id, external_id=f"{kind}{position}", position=position,
                                     raw_json={"artist": "A", "title": title, "liked_at": f"2026-01-0{3 - position}T00:00:00"},
                                     match="not_found" if track_id is None else "owned", status=status, track_id=track_id))
            await s.flush()
            ids = (user.id, imp.id, colls["playlist"].id, (a, c, x))
        yield ids
    finally:
        await db.dispose()


async def shape(playlist_id):
    """The playlist as its places: a track's id, or the name of the row a place is kept for."""
    async with db.session_scope() as s:
        out = []
        for i in await playlists.places(s, playlist_id):
            out.append(i.track_id if i.track_id is not None else (await s.get(ImportItem, i.import_item_id)).raw_json["title"])
        return out


async def settle(imp_id, coll_id):
    async with db.session_scope() as s:
        await apply.sync_playlists(s, await s.get(Import, imp_id))
        return (await s.get(ImportCollection, coll_id)).playlist_id


async def row(coll_id, title):
    async with db.session_scope() as s:
        return next(i.id for i in (await s.execute(select(ImportItem).where(ImportItem.collection_id == coll_id))).scalars()
                    if i.raw_json["title"] == title)


async def test_a_row_the_catalog_does_not_know_keeps_its_place(env):
    user_id, imp_id, coll_id, (a, c, x) = env
    pid = await settle(imp_id, coll_id)
    assert await shape(pid) == [a, "b", c]
    async with db.session_scope() as s:
        assert await playlists.track_ids(s, pid) == [a, c]  # what plays and mirrors goes by the tracks
        assert (await playlists.counts(s, [pid]))[pid][0] == 2
        assert await playlists.missing_counts(s, [pid]) == {pid: 1}
        (place,) = await places_out(s, await playlists.missing(s, pid))
        assert (place.title, place.index, place.status, place.import_id) == ("b", 1, "not_found", imp_id)
    assert await settle(imp_id, coll_id) == pid and await shape(pid) == [a, "b", c]  # settled twice: the same


async def test_the_track_takes_the_place_kept_for_its_row(env):
    user_id, imp_id, coll_id, (a, c, x) = env
    pid = await settle(imp_id, coll_id)
    async with db.session_scope() as s:
        kept = (await playlists.missing(s, pid))[0][0].id
        it = await s.get(ImportItem, await row(coll_id, "b"))
        it.status, it.track_id = "done", x  # the user chose a file for it
    await settle(imp_id, coll_id)
    assert await shape(pid) == [a, x, c]
    async with db.session_scope() as s:
        assert (await s.get(PlaylistItem, kept)).track_id == x  # the same place, with its date


async def test_a_row_left_out_gives_its_place_up(env):
    user_id, imp_id, coll_id, (a, c, x) = env
    pid = await settle(imp_id, coll_id)
    async with db.session_scope() as s:
        (await s.get(ImportItem, await row(coll_id, "b"))).status = "skipped"
    await settle(imp_id, coll_id)
    assert await shape(pid) == [a, c]


async def test_a_like_of_a_song_with_no_track_yet_stands_among_the_likes(env):
    user_id, imp_id, coll_id, (a, c, x) = env
    async with db.session_scope() as s:
        assert await project_liked(s, user_id)
        liked = (await playlists.liked(s, user_id)).id
    assert await shape(liked) == [a, "b", c]  # by the days the songs were liked, the newest on top
    async with db.session_scope() as s:
        assert not await project_liked(s, user_id)
        assert [t.id for _, t in await playlists.items(s, liked)] == [a, c]
