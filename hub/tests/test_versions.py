"""One song, several recordings: versions are tracks of their own, tied by the song."""

from __future__ import annotations

from tests.test_flow import download_one
from tests.test_flow import env as env  # the fixture
from tests.test_flow import src_mp3 as src_mp3  # its file


async def test_versions_are_one_group_with_a_preferred_one(env, monkeypatch):
    from app.catalog.models import CatalogTrack
    from app.db import session_scope
    from app.library.owned import annotate_tracks
    from app.mixes import resolve

    songs = {f"dz:{n}": CatalogTrack(ref=f"dz:{n}", source="dz", id=str(n), title=title, artist="Thomas Mraz", artists=["Thomas Mraz"], duration_s=d)
             for n, title, d in ((71, "Дорогая", 207), (72, "Дорогая (Deluxe)", 243), (73, "Дорогая - Live", 250), (74, "Другая песня", 180))}

    async def catalog_track(ref):
        return songs.get(ref)

    monkeypatch.setattr(resolve, "catalog_track", catalog_track)
    c = env["client"]

    async def of(ref):
        return (await c.get("/api/library/versions", params={"ref": ref})).json()

    old, deluxe, live, other = [(await of(r))["track_id"] for r in songs]
    one = await of("dz:71")
    assert one["song_id"] is None and [(v["title"], v["preferred"], v["label"]) for v in one["versions"]] == [("Дорогая", True, None)]

    r = await c.post(f"/api/library/tracks/{old}/versions", json={"track_id": deluxe})
    assert r.status_code == 200, r.text
    # the track the other was joined to is the preferred one; what a version is, its own name says where it does
    assert [(v["track_id"], v["preferred"], v["label"]) for v in r.json()["versions"]] == [(old, True, None), (deluxe, False, "deluxe")]
    assert (await c.post(f"/api/library/tracks/{old}/versions", json={"track_id": old})).status_code == 422

    # two songs whose tracks are one song become one: joined to any version, a track is a version of them all
    await c.post(f"/api/library/tracks/{live}/versions", json={"track_id": other})
    r = await c.post(f"/api/library/tracks/{deluxe}/versions", json={"track_id": live})
    assert sorted(v["track_id"] for v in r.json()["versions"]) == sorted([old, deluxe, live, other])
    assert [v["track_id"] for v in (await of("dz:74"))["versions"] if v["preferred"]] == [old]
    async with session_scope() as s:
        told = await annotate_tracks(s, list(songs.values()))
        assert [t.versions for t in told] == [4, 4, 4, 4]

    # a list that shows a song once keeps one of its versions: the preferred one, in the place of the first of them
    from app.library import versions as lib

    async with session_scope() as s:
        told = await annotate_tracks(s, [songs["dz:72"], songs["dz:74"], songs["dz:71"]])
        assert [(t.ref, t.versions) for t in await lib.once(s, told)] == [("dz:71", 4)]
        told = await annotate_tracks(s, [songs["dz:73"], songs["dz:72"]])  # the preferred one is not among them: the first
        assert [t.ref for t in await lib.once(s, told)] == ["dz:73"]

    # said by hand, for everyone: the preferred version, and a word for what a version is
    r = await c.patch(f"/api/library/tracks/{old}/version", json={"label": "  старая   версия "})
    assert next(v["label"] for v in r.json()["versions"] if v["track_id"] == old) == "старая версия"
    r = await c.patch(f"/api/library/tracks/{deluxe}/version", json={"preferred": True})
    assert r.json()["versions"][0]["track_id"] == deluxe and r.json()["title"] == "Дорогая (Deluxe)"

    # «это другая песня»: it leaves, the rest stay; the preferred one that leaves hands it on
    r = await c.delete(f"/api/library/tracks/{other}/version", params={"of": old})
    assert sorted(v["track_id"] for v in r.json()["versions"]) == sorted([old, deluxe, live])
    assert (await of("dz:74"))["song_id"] is None
    r = await c.delete(f"/api/library/tracks/{deluxe}/version", params={"of": old})
    assert [v["track_id"] for v in r.json()["versions"] if v["preferred"]] == [old]
    # a song left with one track is no song of several
    r = await c.delete(f"/api/library/tracks/{live}/version", params={"of": old})
    assert r.json()["song_id"] is None and len(r.json()["versions"]) == 1
    assert (await c.patch(f"/api/library/tracks/{old}/version", json={"preferred": True})).status_code == 422

    # what may be joined: the library's own tracks found by the words
    await download_one(c, {"artist": "Кино", "title": "Группа крови"})
    found = (await c.get(f"/api/library/tracks/{old}/versions/find", params={"q": "группа крови"})).json()
    assert [v["title"] for v in found] == ["Группа крови"] and found[0]["has_file"]

    # a version that only the catalog has is joined by its ref: it becomes a track here
    songs["dz:75"] = CatalogTrack(ref="dz:75", source="dz", id="75", title="Дорогая (Remix)", artist="Thomas Mraz", artists=["Thomas Mraz"], duration_s=200)
    r = await c.post(f"/api/library/tracks/{old}/versions", json={"ref": "dz:75"})
    assert r.status_code == 200 and [(v["ref"], v["label"], v["has_file"]) for v in r.json()["versions"]] == [("dz:71", None, False), ("dz:75", "remix", False)], r.text
    assert (await c.post(f"/api/library/tracks/{old}/versions", json={"ref": "dz:404"})).status_code == 404


async def test_a_doubt_is_answered_another_version_of_the_same_song(env, monkeypatch):
    """«Is it that record?» has a third answer: the track stays as it is, tied to the catalog's record as a version."""
    from sqlalchemy import select

    from app.catalog.models import CatalogTrack
    from app.db import session_scope
    from app.mixes import resolve
    from app.models import Track, Upgrade

    cat = CatalogTrack(ref="dz:81", source="dz", id="81", title="Дорогая", artist="Thomas Mraz", artists=["Thomas Mraz"], duration_s=243)

    async def catalog_track(ref):
        return cat if ref == "dz:81" else None

    monkeypatch.setattr(resolve, "catalog_track", catalog_track)
    c = env["client"]
    await download_one(c, {"artist": "Кино", "title": "Группа крови"})
    async with session_scope() as s:
        mine = (await s.execute(select(Track).where(Track.title == "Группа крови"))).scalars().first()
        row = Upgrade(user_id=mine.created_by or 1, track_id=mine.id, kind="identify", state="kept", meta_json={"track_ref": "dz:81"})
        user = (await s.execute(select(Upgrade.user_id).join(Track, Track.id == Upgrade.track_id).limit(1))).scalar_one_or_none()
        from app.models import User

        row.user_id = (await s.execute(select(User.id).limit(1))).scalar_one()
        s.add(row)
        await s.flush()
        row_id, mine_id = row.id, mine.id
        del user
    r = await c.post(f"/api/quality/{row_id}/version")
    assert r.status_code == 200, r.text
    d = (await c.get("/api/library/versions", params={"track_id": mine_id})).json()
    # the catalog's record is the preferred one — the one the other was joined to; the track keeps its names and file
    assert [(v["title"], v["preferred"], v["has_file"]) for v in d["versions"]] == [("Дорогая", True, False), ("Группа крови", False, True)]


async def test_an_uploaded_file_is_said_to_be_another_version(env, tmp_path):
    """On the upload page: neither the catalog's record nor another song — the file goes in under its own names,
    tied to the record as a version, and nothing is asked of it afterwards."""
    from tests.test_flow import make_mp3

    c = env["client"]
    p = make_mp3(tmp_path / "x.mp3", seconds=2)
    (u,) = (await c.post("/api/uploads", files=[("files", ("Кино - Группа крови.mp3", p.read_bytes(), "audio/mpeg"))])).json()
    assert u["match"]["ref"] == "dz:100", u["match"]
    r = await c.post("/api/uploads/commit", json={"tracks": [{"upload_id": u["id"], "catalog": False, "title": "Группа крови (старая)", "artist": "Кино",
                                                              "album": "Демо", "version_of_match": True}]})
    assert r.status_code == 200 and r.json()["imported"] == 1 and r.json()["unsure"] == 0, r.text
    (tid,) = r.json()["track_ids"]
    d = (await c.get("/api/library/versions", params={"track_id": tid})).json()
    assert [(v["title"], v["ref"], v["preferred"], v["has_file"]) for v in d["versions"]] == [
        ("Группа крови", "dz:100", True, False), ("Группа крови (старая)", None, False, True)]

