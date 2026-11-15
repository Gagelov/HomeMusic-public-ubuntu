"""«Качество звука»: the weak files of the library looked for anew (app/library/upgrade.py) — the queue, what was
found, and the listener's word on the files that are only alike."""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import current_user
from app.db import get_session
from app.events import bus
from app.jobs.downloads import enqueue_scan
from app.jobs.queue import notify
from app.library import access, upgrade
from app.library.importer import library_abs
from app.library.tracks import current_file, current_files
from app.models import DownloadItem, Track, TrackFile, Upgrade, User

router = APIRouter(prefix="/api/quality", tags=["quality"])


class QualityIn(BaseModel):
    """The tracks to look for a better file of (none: every weak file the asker looks after)."""

    track_ids: list[int] | None = Field(default=None, max_length=20000)


class QualityRow(BaseModel):
    id: int
    track_id: int
    title: str
    artist: str
    cover_url: str | None = None
    state: str  # queued / searching / found / replaced / none / kept
    kind: str = "better"  # "identify": whether the track is the catalog's record `record`, told by the sound
    record: str | None = None  # that record, in words: «Название — Исполнитель · альбом»
    progress: float = 0  # of the download under way, 0…1
    known: bool = False  # the catalog knows the song: it is found sooner and surer
    was_codec: str | None = None
    was_kbps: int | None = None
    codec: str | None = None  # of the file found
    bitrate_kbps: int | None = None
    likeness: float | None = None
    provider: str | None = None
    note: str | None = None
    duration_s: int | None = None
    can_revert: bool = False  # the file it had is still kept: both can be heard, the old one brought back
    updated_at: datetime


class QualityOut(BaseModel):
    rows: list[QualityRow]
    weak: int  # weak files the asker looks after that nothing was looked for yet


def _record(meta: dict | None) -> str | None:
    m = meta or {}
    if not m.get("title"):
        return None
    return f"{m['title']} — {m.get('artist') or ''}" + (f" · «{m['album']}»" if m.get("album") else "")


def _cover(t: Track) -> str | None:
    if t.cover_key:
        return f"/api/library/tracks/{t.id}/cover?v={t.cover_key}"
    return f"/api/library/albums/{t.album_id}/cover" if t.album_id else None


async def _weak_ids(s: AsyncSession, user: User) -> list[int]:
    ids = list((await s.execute(select(Track.id).join(TrackFile, TrackFile.track_id == Track.id).where(access.tracks_of(user)).distinct())).scalars())
    files = await current_files(s, ids)
    return [i for i in ids if upgrade.wanted(files.get(i))]


@router.get("", response_model=QualityOut)
async def listed(user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    rows = (await s.execute(
        select(Upgrade, Track, DownloadItem.progress).join(Track, Track.id == Upgrade.track_id)
        .join(DownloadItem, DownloadItem.id == Upgrade.item_id, isouter=True)
        .where(Upgrade.user_id == user.id).order_by(Upgrade.updated_at.desc(), Upgrade.id.desc()))).all()
    seen: set[int] = set()
    out = []
    for row, t, progress in rows:  # of a track looked for twice, the last time
        if t.id in seen:
            continue
        seen.add(t.id)
        out.append(QualityRow(
            id=row.id, track_id=t.id, title=t.title, artist=t.artist, cover_url=_cover(t), state=row.state,
            kind=row.kind, record=_record(row.meta_json) if row.kind == "identify" else None,
            progress=float(progress or 0) if row.state == "searching" else 0, known=str(t.ref or "").startswith("dz:"),
            was_codec=row.was_codec, was_kbps=row.was_kbps, codec=row.codec, bitrate_kbps=row.bitrate_kbps,
            likeness=row.likeness, provider=row.provider, note=row.note, duration_s=t.duration_s,
            can_revert=row.state == "replaced" and upgrade.was(row) is not None, updated_at=row.updated_at))
    return QualityOut(rows=out, weak=len([i for i in await _weak_ids(s, user) if i not in seen]))


@router.post("/start")
async def start(body: QualityIn, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")) -> dict:
    """Look for a better file of these tracks (none: of every weak file the asker looks after)."""
    ids = body.track_ids if body.track_ids is not None else await _weak_ids(s, user)
    n = await upgrade.start(s, user.id, ids)
    await s.commit()
    notify()
    return {"queued": n}


async def _row(s: AsyncSession, user: User, row_id: int) -> Upgrade:
    row = await s.get(Upgrade, row_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Не найдено")
    return row


@router.post("/{row_id}/accept")
async def accept(row_id: int, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")) -> dict:
    row = await _row(s, user, row_id)
    try:
        await upgrade.accept(s, row, user.id)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    await enqueue_scan(s)
    await s.commit()
    notify()
    bus.publish(user.id, "library", {"kind": "imported", "track_id": row.track_id})
    return {"ok": True}


@router.post("/{row_id}/revert")
async def revert(row_id: int, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")) -> dict:
    """Take back the file the track had before a better one was put in its place."""
    row = await _row(s, user, row_id)
    try:
        await upgrade.revert(s, row, user.id)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    await enqueue_scan(s)
    await s.commit()
    notify()
    bus.publish(user.id, "library", {"kind": "imported", "track_id": row.track_id})
    return {"ok": True}


@router.post("/{row_id}/decline")
async def decline(row_id: int, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")) -> dict:
    row = await _row(s, user, row_id)
    try:
        await upgrade.decline(s, row)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    return {"ok": True}


async def _file(s: AsyncSession, row: Upgrade, which: str):
    if which == "found":
        path = upgrade.staged(row)
    elif which == "was":
        path = upgrade.was(row)
    else:
        f = await current_file(s, row.track_id)
        path = library_abs(f.path) if f else None
    if path is None or not path.is_file():
        raise HTTPException(404, "Файла нет")
    return path


@router.get("/{row_id}/audio/{which}")
async def audio(row_id: int, which: str, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    """The file the track has («current»), the one found for it («found») or the one it had («was»), to listen to."""
    return FileResponse(await _file(s, await _row(s, user, row_id), which), headers={"Cache-Control": "no-store"})


@router.get("/{row_id}/peaks")
async def peaks(row_id: int, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")) -> dict:
    """The loudness of the two files along their length: what the listener moves through them by."""
    row = await _row(s, user, row_id)
    out = {}
    for which in ("current", "found", "was"):
        try:
            out[which] = await upgrade.peaks(await _file(s, row, which))
        except HTTPException:
            out[which] = []
    return out
