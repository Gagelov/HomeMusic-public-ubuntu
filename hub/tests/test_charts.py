"""«Чарты и жанры» (app/charts.py): the list and the moods a listener gets of their own library and a tag."""

from __future__ import annotations

from app import charts
from app.api.schemas import ChartOut


def test_mood_charts_are_personal_and_have_a_fallback() -> None:
    moods = [c for c in charts.CHARTS.values() if c.group == "moods"]

    assert {c.id for c in moods} == {"mood_calm", "mood_energy", "mood_sad", "mood_happy", "mood_romantic", "mood_focus"}
    assert all(c.personal and c.lastfm_tag and c.deezer_playlist is not None for c in moods)


def test_a_mood_is_a_chart_the_api_can_say() -> None:
    c = charts.CHARTS["mood_calm"]

    out = ChartOut(id=c.id, title=c.title, name=c.name, kind=c.kind, group=c.group, source=c.source)

    assert out.group == "moods" and out.id == "mood_calm"
