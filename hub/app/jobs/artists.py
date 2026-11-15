"""The library written in an artist's name (app/library/artists.py `rewrite`): the rows and the files' tags."""

from __future__ import annotations

import logging

from app.db import session_scope
from app.jobs.downloads import enqueue_scan
from app.jobs.queue import handler, notify
from app.models import Artist, Job

log = logging.getLogger(__name__)


@handler("artist_rewrite")
async def handle_artist_rewrite(job: Job) -> None:
    from app.events import bus
    from app.library import artists

    user_id = job.payload_json.get("user_id")
    async with session_scope() as s:
        artist = await s.get(Artist, int(job.payload_json["artist_id"]))
        if artist is None:  # joined with another since: that one's own job writes the library
            return
        n = await artists.rewrite(s, artist, user_id)
        if n:
            await enqueue_scan(s)
        log.info("artist %s (%s): %s rows rewritten", artist.id, artist.name, n)
    if n:
        notify()
        if user_id:
            bus.publish(int(user_id), "library", {"kind": "changed", "album_id": None})
