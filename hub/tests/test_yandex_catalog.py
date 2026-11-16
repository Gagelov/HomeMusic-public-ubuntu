"""Yandex Music as a catalog: its records become the Hub's (`ym:<id>`), named as Yandex names them."""

from types import SimpleNamespace as NS

from app.catalog import yandex_catalog as ym
from app.catalog.models import CatalogAlbum, CatalogArtist, CatalogTrack, SearchResults


def artist(id_, name):
    return NS(id=id_, name=name, various=False, cover=NS(uri="a.net/p/%%"), og_image=None, counts=NS(direct_albums=17),
              likes_count=100)


def album(id_=7, **over):
    return NS(**{"id": id_, "title": "Акустический альбом", "version": None, "artists": [artist(1, "Король и Шут")],
                 "type": None, "year": 1999, "release_date": "2023-12-30T00:00:00+03:00", "cover_uri": "a.net/c/%%",
                 "track_count": 18, "content_warning": None, "genre": "folkrock", **over})


def track(id_=5, **over):
    al = album()
    al.track_position = NS(volume=1, index=3)
    return NS(**{"id": id_, "title": "Кукла колдуна", "version": "Live", "type": "music", "duration_ms": 203920,
                 "artists": [artist(1, "Король и Шут"), artist(2, "Гость")], "albums": [al], "cover_uri": None,
                 "explicit": False, "content_warning": None, **over})


def test_a_track_is_named_as_yandex_names_it():
    t = ym.track_of(track())
    assert isinstance(t, CatalogTrack)
    assert (t.ref, t.source, t.title, t.artist) == ("ym:5", "ym", "Кукла колдуна (Live)", "Король и Шут")
    assert (t.artists, t.artist_refs, t.artist_ref) == (["Король и Шут", "Гость"], ["ym:1", "ym:2"], "ym:1")
    assert (t.album_ref, t.album_title, t.track_no, t.disc_no, t.duration_s) == ("ym:7", "Акустический альбом", 3, 1, 204)
    assert t.cover_url == "https://a.net/c/1000x1000" and t.cover_small_url == "https://a.net/c/200x200"
    assert ym.track_of(track(type="podcast-episode")) is None


def test_a_release_keeps_the_year_of_the_music_not_the_day_of_a_reissue():
    a = ym.album_of(album())
    assert isinstance(a, CatalogAlbum)
    assert (a.ref, a.record_type, a.year, a.release_date) == ("ym:7", "album", 1999, None)
    assert (a.artist, a.artist_ref) == ("Король и Шут", "ym:1")
    b = ym.album_of(album(type="single", year=2023))
    assert (b.record_type, b.release_date.isoformat()) == ("single", "2023-12-30")
    assert ym.album_of(album(type="compilation")).record_type == "compile"


def test_an_artist_has_their_picture_and_followers():
    a = ym.artist_of(artist(41052, "Король и Шут"))
    assert isinstance(a, CatalogArtist)
    assert (a.ref, a.nb_fans, a.nb_albums, a.picture_small_url) == ("ym:41052", 100, 17, "https://a.net/p/200x200")


def test_what_another_catalog_found_is_added_once():
    from app.api.search import _with

    dz = SearchResults(tracks=[CatalogTrack(ref="dz:1", source="dz", id="1", title="Кукла колдуна", artist="Король и Шут")],
                       artists=[CatalogArtist(ref="dz:9", source="dz", id="9", name="Король и Шут")])
    more = SearchResults(tracks=[ym.track_of(track(version=None)), ym.track_of(track(id_=6, title="Лесник", version=None))],
                         artists=[ym.artist_of(artist(41052, "король и шут")), ym.artist_of(artist(3, "Ария"))])
    got = _with(dz, more)
    assert [t.ref for t in got.tracks] == ["dz:1", "ym:6"]
    assert [a.ref for a in got.artists] == ["dz:9", "ym:3"]


def test_two_catalogs_records_of_one_release():
    from datetime import date

    from app.api.catalog import same_release

    def rel(src, title, artist="GONE.Fludd", year=2026, n=10, day=None):
        return CatalogAlbum(ref=f"{src}:1", source=src, id="1", title=title, artist=artist, year=year, nb_tracks=n, release_date=day)

    dz = rel("dz", "Любовь и Ракеты, Ч.1", year=None, day=date(2026, 3, 1))
    assert same_release(dz, rel("ym", "Любовь и ракеты, ч.1"))
    assert same_release(dz, rel("ym", "Любовь и Ракеты, Ч.1 (Deluxe)"))  # what is written after the name is not it
    assert same_release(dz, rel("ym", "Любовь и Ракеты, Ч.1", year=2027))  # a reissue: as many tracks
    assert not same_release(dz, rel("ym", "Любовь и Ракеты, Ч.1", year=2027, n=12))
    assert not same_release(dz, rel("ym", "Любовь и Ракеты, Ч.2"))
    assert not same_release(dz, rel("ym", "Любовь и Ракеты, Ч.1", artist="Другой"))
