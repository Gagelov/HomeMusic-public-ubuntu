"""A better file in the place of a weak one.

A file brought from outside may be poor — an MP3 at 128 found somewhere. The song is looked for anew through the
sources, as any download, and a file found takes the old one's place only when it is the same recording, told by
its sound (`acoustic.SAME`: not a live take, not a version in another language), and is the better file of the two
(`quality.better`). Nothing better: the old file stays, and nobody is asked anything — the download is a quiet one.

The track stays the track: its places in playlists, its likes, its lyrics and tags are its own, only the file under
it changes. The old file goes to the trash folder with the rest of what is deleted.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from app.config import get_settings
from app.library import acoustic, quality
from app.library.importer import _move, library_abs, library_lock
from app.library.layout import unique_path
from app.library.tracks import current_file
from app.models import DownloadBatch, DownloadItem, Track, TrackFile

log = logging.getLogger(__name__)


def wanted(track: Track, file: TrackFile | None) -> bool:
    """A track worth looking for anew: its file is weak, and the catalog knows the song (a download is made by a
    record of the catalog)."""
    return file is not None and str(track.ref or "").startswith("dz:") and quality.weak(file.codec, file.bitrate_kbps)


async def enqueue(s: AsyncSession, user_id: int, track_ids: list[int]) -> int:
    """Queue the search of a better file for these tracks — the ones `wanted`, and not looked for already. How many
    were queued."""
    from app.jobs.queue import enqueue as enqueue_job
    from app.library.owned import ACTIVE_STATUSES
    from app.providers.base import TrackQuery

    busy = {(i.query_json or {}).get("upgrade") for i in (await s.execute(
        select(DownloadItem).where(DownloadItem.user_id == user_id, DownloadItem.status.in_(ACTIVE_STATUSES)))).scalars()}
    batch: DownloadBatch | None = None
    n = 0
    for tid in dict.fromkeys(track_ids):
        track = await s.get(Track, tid)
        file = await current_file(s, tid) if track is not None else None
        if track is None or tid in busy or not wanted(track, file):
            continue
        if batch is None:
            batch = DownloadBatch(user_id=user_id, origin="upgrade", title="Лучшее качество")
            s.add(batch)
            await s.flush()
        q = TrackQuery(artist=track.artist, title=track.title, duration_s=track.duration_s, isrc=track.isrc, explicit=track.explicit)
        ident = track.ref.split(":", 1)[1]
        item = DownloadItem(batch_id=batch.id, user_id=user_id, force=True, query_json={
            "query": q.model_dump(), "upgrade": tid, "replaces_song": file.nd_song_id,
            "meta": {"track_ref": track.ref, "deezer_track_id": ident, "upgrade_of": tid}})
        s.add(item)
        await s.flush()
        await enqueue_job(s, "download_item", {"item_id": item.id})
        n += 1
    return n


async def fits(s: AsyncSession, track_id: int, path: Path, codec: str | None, kbps: int | None) -> tuple[bool, str]:
    """Whether the file found may take the place of the track's own: (yes, "") or (no, why not)."""
    old = (await s.execute(select(TrackFile).where(TrackFile.track_id == track_id).options(undefer(TrackFile.chroma))
                           .order_by(TrackFile.id.desc()).limit(1))).scalar_one_or_none()
    if old is None:
        return True, ""
    if not quality.better(codec, kbps, old.codec, old.bitrate_kbps):
        return False, f"не лучше имеющегося ({(old.codec or '?').upper()} {old.bitrate_kbps or '?'})"
    if not old.chroma:
        return False, "у имеющегося файла нет отпечатка звука — сравнить не с чем"
    got = await acoustic.of_file(path)
    if not got:
        return False, "не удалось снять отпечаток звука"
    alike = await asyncio.to_thread(acoustic.likeness, got[0], old.chroma)
    if alike < acoustic.SAME:
        return False, f"это другая запись (сходство по звуку {alike:.2f})"
    return True, ""


async def shelve(s: AsyncSession, track_id: int) -> list[tuple[Path, Path]]:
    """Take the track's files out of the library into the trash folder, their rows with them — the new file comes
    in their place. [(where it went, where it was)]: `unshelve` puts them back if the new file does not come."""
    moved: list[tuple[Path, Path]] = []
    async with library_lock:
        for f in list((await s.execute(select(TrackFile).where(TrackFile.track_id == track_id))).scalars()):
            src = library_abs(f.path)
            if src.is_file():
                dest = get_settings().trash_dir / datetime.now().strftime("%Y-%m-%d") / Path(*PurePosixPath(f.path).parts)
                if dest.exists():
                    dest = unique_path(dest.parent, dest.name)
                await asyncio.to_thread(_move, src, dest)
                moved.append((dest, src))
            await s.delete(f)
        await s.flush()
    return moved


async def unshelve(moved: list[tuple[Path, Path]]) -> None:
    for trashed, home in moved:
        if trashed.is_file() and not home.exists():
            await asyncio.to_thread(_move, trashed, home)


def of_meta(meta: dict[str, Any]) -> int | None:
    v = meta.get("upgrade_of")
    return int(v) if v else None
