"""An artist's one name and other spellings, projects of one person, and the other names of a track."""

from __future__ import annotations

from tests.test_flow import download_one, drain_jobs
from tests.test_flow import env as env  # the fixture
from tests.test_flow import src_mp3 as src_mp3  # its file


async def _library_track():
    from sqlalchemy import select

    from app.db import session_scope
    from app.models import Album, Track, TrackFile

    async with session_scope() as s:
        t = (await s.execute(select(Track).join(TrackFile, TrackFile.track_id == Track.id))).scalars().first()
        f = (await s.execute(select(TrackFile).where(TrackFile.track_id == t.id))).scalars().first()
        a = await s.get(Album, t.album_id) if t.album_id else None
        return t, f, a


async def test_a_spelling_made_the_name_rewrites_the_library_and_its_files(env):
    from app.library import tagger
    from app.library.importer import library_abs

    c = env["client"]
    await download_one(c, {"artist": "Кино", "title": "Группа крови"})
    card = (await c.get("/api/artists/of", params={"name": "кино"})).json()  # the letters' case is no other artist
    assert card["name"] == "Кино" and [n["main"] for n in card["names"]] == [True]

    r = await c.post(f"/api/artists/{card['id']}/names", json={"name": "Kino"})
    assert r.status_code == 200 and [n["name"] for n in r.json()["names"]] == ["Кино", "Kino"], r.text
    # the search finds the track by the spelling, and says so
    (own,) = (await c.get("/api/search", params={"q": "kino gruppa"})).json()["library"]
    assert own["title"] == "Группа крови"
    (own,) = (await c.get("/api/search", params={"q": "Kino"})).json()["library"]
    assert own["found_by"] == [] or own["found_by"] == ["Kino"]  # «кино» reads «kino» by itself

    kino = next(n for n in r.json()["names"] if n["name"] == "Kino")
    r = await c.post(f"/api/artists/{card['id']}/main", json={"name_id": kino["id"]})
    assert r.status_code == 200 and r.json()["name"] == "Kino" and r.json()["rewriting"], r.text
    await drain_jobs()
    t, f, a = await _library_track()
    assert (t.artist, t.album_artist, a.album_artist) == ("Kino", "Kino", "Kino")
    tags = tagger.read_tags(library_abs(f.path))
    assert tags["artist"] == "Kino" and tags["album_artist"] == "Kino", tags
    hist = (await c.get(f"/api/library/tracks/{t.id}/edits")).json()
    assert any(h["changes"].get("artist") == ["Кино", "Kino"] for h in hist), hist

    # what comes under the other spelling from now on is filed under the name
    from app.db import session_scope
    from app.library import artists

    async with session_scope() as s:
        assert await artists.line(s, "кино, Ноль") == "Kino, Ноль"


async def test_two_artists_are_joined_and_one_may_be_set_apart(env):
    c = env["client"]
    a = (await c.get("/api/artists/of", params={"name": "ЛСП"})).json()
    b = (await c.get("/api/artists/of", params={"name": "LSP", "ref": "dz:artist:7"})).json()
    assert a["id"] != b["id"]
    # the two read alike in Latin letters: each is offered to the other
    a = (await c.get("/api/artists/of", params={"name": "ЛСП"})).json()
    assert [x["name"] for x in a["suggestions"]] == ["LSP"]
    # a spelling that is somebody's is not taken silently
    r = await c.post(f"/api/artists/{a['id']}/names", json={"name": "lsp"})
    assert r.status_code == 409 and r.json()["detail"]["artist_id"] == b["id"], r.text

    r = await c.post(f"/api/artists/{a['id']}/merge", json={"other_id": b["id"]})
    assert r.status_code == 200 and [n["name"] for n in r.json()["names"]] == ["ЛСП", "LSP"] and not r.json()["suggestions"], r.text
    await drain_jobs()
    # the catalog's page of «LSP» is the artist's now, under the one name
    again = (await c.get("/api/artists/of", params={"name": "LSP", "ref": "dz:artist:7"})).json()
    assert (again["id"], again["name"]) == (a["id"], "ЛСП")
    assert [x["name"] for x in (await c.get("/api/artists/find", params={"q": "lsp"})).json()] == ["ЛСП"]
    # a catalog's own card of the artist is shown under the name here
    from app.catalog.models import CatalogArtist
    from app.db import session_scope
    from app.library import artists

    async with session_scope() as s:
        got = await artists.shown(s, [CatalogArtist(ref="dz:artist:7", source="dz", id="7", name="LSP"),
                                      CatalogArtist(ref="dz:artist:8", source="dz", id="8", name="Lsp"),
                                      CatalogArtist(ref="dz:artist:9", source="dz", id="9", name="Кино")])
        assert [a.name for a in got] == ["ЛСП", "ЛСП", "Кино"]

    lsp = next(n for n in again["names"] if n["name"] == "LSP")
    r = await c.delete(f"/api/artists/{a['id']}/names/{lsp['id']}")
    assert r.status_code == 200 and [n["name"] for n in r.json()["names"]] == ["ЛСП"], r.text
    assert r.json()["suggestions"] == []  # set apart by hand: not offered again
    main = r.json()["names"][0]
    assert (await c.delete(f"/api/artists/{a['id']}/names/{main['id']}")).status_code == 422


async def test_a_project_is_linked_not_joined(env):
    c = env["client"]
    a = (await c.get("/api/artists/of", params={"name": "GONE.Fludd"})).json()
    r = await c.post(f"/api/artists/{a['id']}/projects", json={"name": "M00NCHILD"})
    assert r.status_code == 200 and [p["name"] for p in r.json()["projects"]] == ["M00NCHILD"], r.text
    other = (await c.get("/api/artists/of", params={"name": "m00nchild"})).json()
    assert other["id"] != a["id"] and [p["name"] for p in other["projects"]] == ["GONE.Fludd"]
    assert (await c.post(f"/api/artists/{a['id']}/projects", json={"other_id": a["id"]})).status_code == 422
    # the projects of one person are one group: a third, named on one page, is on the pages of all
    r = await c.post(f"/api/artists/{other['id']}/projects", json={"name": "Третий"})
    third = next(p for p in r.json()["projects"] if p["name"] == "Третий")
    assert sorted(p["name"] for p in r.json()["projects"]) == ["GONE.Fludd", "Третий"]
    assert sorted(p["name"] for p in (await c.get("/api/artists/of", params={"name": "GONE.Fludd"})).json()["projects"]) == ["M00NCHILD", "Третий"]
    assert sorted(p["name"] for p in (await c.get("/api/artists/of", params={"name": "Третий"})).json()["projects"]) == ["GONE.Fludd", "M00NCHILD"]
    # the one in the middle leaves: the other two stay each other's
    r = await c.delete(f"/api/artists/{a['id']}/projects/{other['id']}")
    assert r.status_code == 200 and [p["name"] for p in r.json()["projects"]] == ["Третий"], r.text
    assert (await c.get("/api/artists/of", params={"name": "M00NCHILD"})).json()["projects"] == []
    r = await c.delete(f"/api/artists/{a['id']}/projects/{third['id']}")
    assert r.status_code == 200 and r.json()["projects"] == []


async def test_a_track_is_found_by_its_other_names(env):
    c = env["client"]
    await download_one(c, {"artist": "Кино", "title": "Группа крови"})
    t, _, _ = await _library_track()
    assert (await c.get("/api/search", params={"q": "марафоны"})).json()["library"] == []
    r = await c.post(f"/api/library/tracks/{t.id}/names", json={"name": "Марафоны"})
    assert r.status_code == 200 and [(n["name"], n["source"]) for n in r.json()["names"]] == [("Марафоны", "manual")], r.text
    (own,) = (await c.get("/api/search", params={"q": "marafony кино"})).json()["library"]
    assert own["title"] == "Группа крови" and own["found_by"] == ["Марафоны"]
    (own,) = (await c.get("/api/search", params={"q": "gruppa krovi"})).json()["library"]  # Latin for Cyrillic
    assert own["found_by"] == []

    # renamed: the name it had is one it is found by, and its new name is not among the others
    r = await c.patch(f"/api/library/tracks/{t.id}", json={"title": "Марафоны"})
    assert r.status_code == 200, r.text
    info = (await c.get("/api/library/track-edit", params={"track_id": t.id})).json()
    assert info["title"] == "Марафоны" and ("Группа крови", "renamed") in [(n["name"], n["source"]) for n in info["names"]]
    assert "Марафоны" not in [n["name"] for n in info["names"]]
    (own,) = (await c.get("/api/search", params={"q": "группа крови"})).json()["library"]
    assert own["title"] == "Марафоны"  # (the album is still called so: the row itself shows the words)
    kept = next(n for n in info["names"] if n["id"])
    r = await c.delete(f"/api/library/tracks/{t.id}/names/{kept['id']}")
    assert r.status_code == 200 and kept["id"] not in [n["id"] for n in r.json()["names"]]
