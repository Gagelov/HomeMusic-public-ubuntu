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
