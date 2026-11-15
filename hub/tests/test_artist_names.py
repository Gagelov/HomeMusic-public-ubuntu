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
        assert (await artists.credits(s, "кино, Ноль"))[0] == "Kino, Ноль"


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
        # …and another record under their spelling is not theirs by the name alone: a namesake, perhaps
        assert [a.name for a in got] == ["ЛСП", "Lsp", "Кино"]

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


async def test_a_catalog_keeps_several_records_of_one_artist_and_a_namesake_is_somebody_else(env, monkeypatch):
    """The first record of the catalog is the artist's by itself; another under their spelling is a namesake until
    a listener joins the two — then the page is drawn of both records, and the namesake's music stays theirs."""
    from datetime import date

    from app.api import catalog
    from app.catalog.models import ArtistPage, CatalogAlbum, CatalogArtist, CatalogTrack
    from app.db import session_scope
    from app.library import artists
    from app.library.owned import annotate_tracks

    def page(id_, name, fans, albums, top=()):
        a = CatalogArtist(ref=f"dz:{id_}", source="dz", id=str(id_), name=name, nb_fans=fans)
        return ArtistPage(artist=a, albums=[CatalogAlbum(ref=f"dz:al{n}", source="dz", id=f"al{n}", title=title, artist=name, artist_ref=a.ref,
                                                         record_type="album", release_date=date(year, 1, 1)) for n, title, year in albums],
                          top_tracks=[CatalogTrack(ref=f"dz:t{n}", source="dz", id=f"t{n}", title=title, artist=name, artists=[name],
                                                   artist_refs=[a.ref], artist_ref=a.ref, rank=rank) for n, title, rank in top])

    pages = {"dz:1": page(1, "ЛСП", 1000, [(1, "Искра", 2026), (2, "Общий", 2020)], [(1, "Новое", 5)]),
             "dz:2": page(2, "LSP", 10, [(3, "Magic City", 2015), (4, "Obschiy", 2020)], [(2, "Staroe", 9)]),
             "dz:3": page(3, "LSP", 500, [(5, "Boots and Suits", 2026)], [(3, "Boots", 7)])}

    async def get_artist_page(ref):
        return pages[ref]

    monkeypatch.setattr(catalog, "get_artist_page", get_artist_page)
    c = env["client"]
    one = (await c.get("/api/catalog/artist/dz:1")).json()
    two = (await c.get("/api/catalog/artist/dz:2")).json()  # «LSP»: nobody's spelling yet — an artist of its own
    assert (one["artist"]["name"], one["profiles"], two["artist"]["name"], two["profiles"]) == ("ЛСП", ["dz:1"], "LSP", ["dz:2"])
    a = (await c.get("/api/artists/of", params={"ref": "dz:1"})).json()
    b = (await c.get("/api/artists/of", params={"ref": "dz:2"})).json()
    assert [x["name"] for x in a["suggestions"]] == ["LSP"] and a["suggestions"][0]["ref"] == "dz:2"
    r = await c.post(f"/api/artists/{a['id']}/merge", json={"other_id": b["id"]})
    assert r.status_code == 200 and r.json()["profiles"] == ["dz:1", "dz:2"], r.text

    # one page, whichever record it is opened by: the name here, the releases of both, the followers of both
    for ref in ("dz:1", "dz:2"):
        d = (await c.get(f"/api/catalog/artist/{ref}")).json()
        assert (d["artist"]["name"], d["artist"]["ref"], d["artist"]["nb_fans"], d["profiles"]) == ("ЛСП", "dz:1", 1010, ["dz:1", "dz:2"])
        assert {x["title"] for x in d["albums"]} == {"Искра", "Общий", "Magic City"}  # «Obschiy» of 2020 is «Общий»
        assert [t["title"] for t in d["top_tracks"]] == ["Staroe"] and d["top_tracks"][0]["artist"] == "ЛСП"

    # a third record under a spelling of theirs: not theirs by the name alone
    three = (await c.get("/api/catalog/artist/dz:3")).json()
    assert (three["artist"]["name"], three["profiles"]) == ("LSP", ["dz:3"])
    band = (await c.get("/api/artists/of", params={"ref": "dz:3"})).json()
    assert band["id"] != a["id"] and band["held_by"] == "ЛСП" and band["names"][0] == {"id": None, "name": "LSP", "source": "catalog", "main": True}
    assert [x["ref"] for x in (await c.get("/api/artists/of", params={"ref": "dz:1"})).json()["suggestions"]] == ["dz:3"]
    async with session_scope() as s:
        told = await annotate_tracks(s, [pages["dz:2"].top_tracks[0], pages["dz:3"].top_tracks[0]])
        assert [t.artist for t in told] == ["ЛСП", "LSP"]  # the artist's own record, and the namesake's
        cards = await artists.shown(s, [pages[r].artist for r in ("dz:2", "dz:1", "dz:3")])
        assert [(x.ref, x.name) for x in cards] == [("dz:1", "ЛСП"), ("dz:3", "LSP")]  # one card an artist
        # music that says only the name is the artist's whose spelling it is; the catalog's record says otherwise
        assert (await artists.credits(s, "LSP"))[0] == "ЛСП"
        assert (await artists.credits(s, "LSP", {"lsp": "dz:3"}))[0] == "LSP"
        await s.rollback()
    r = await c.post(f"/api/artists/{a['id']}/apart", json={"other_id": band["id"]})
    assert r.status_code == 200 and r.json()["suggestions"] == []

    # «Не включать» is of the whole artist: put on one record, it is of the other too — and not of the namesake
    r = await c.post("/api/dislikes", json={"artist_ref": "dz:2", "artist": "LSP"})
    assert r.status_code == 200 and sorted(r.json()["artist_refs"]) == ["dz:1", "dz:2"], r.text
    assert sorted(r.json()["artist_names"]) == ["LSP", "ЛСП"]
    assert (await c.post("/api/dislikes", json={"artist_ref": "dz:1", "artist": "ЛСП"})).json()["id"] == r.json()["id"]  # one mark
    from sqlalchemy import select

    from app.mixes.taste import build_profile
    from app.models import User

    async with session_scope() as s:
        user = (await s.execute(select(User).limit(1))).scalars().first()
        prof = await build_profile(s, user)
        hid = lambda name, ref: prof.disliked(ref=None, nd_song_id=None, artist=name, artist_ref=ref, artists=[name], artist_refs=[ref])  # noqa: E731
        assert hid("ЛСП", "dz:1") and hid("LSP", "dz:2") and hid("lsp", None)
        assert not hid("LSP", "dz:3")  # the namesake's own record says it is somebody else
    assert (await c.delete("/api/dislikes", params={"artist_ref": "dz:1"})).json() == {"removed": 1}
    assert (await c.get("/api/dislikes")).json() == []
