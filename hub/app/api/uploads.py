"""Uploads of own audio files from the phone (FR-5): stream to staging → edit tags → import into an album."""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import UploadCommitIn, UploadCommitOut, UploadOut, UploadTwin
from app.auth import current_user
from app.config import get_settings
from app.db import get_session
from app.events import bus
from app.jobs.downloads import enqueue_scan
from app.jobs.queue import notify
from app.library import access, acoustic, probe, tagger
from app.library.credits import split_artists
from app.library.owned import find_owned
from app.library.tracks import current_file
from app.library.importer import ImportSpec, import_file
from app.models import Album, Track, Upload, User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

CHUNK = 1024 * 1024


LOSSLESS = {"flac", "alac", "wav", "pcm_s16le", "ape", "wavpack"}
BETTER_BY_KBPS = 48  # a lossy file is the better one when its bitrate is higher by at least this


def _better(codec: str | None, kbps: int | None, than_codec: str | None, than_kbps: int | None) -> bool:
    mine, theirs = (codec or "").lower() in LOSSLESS, (than_codec or "").lower() in LOSSLESS
    if mine != theirs:
        return mine
    return not mine and bool(kbps and than_kbps and kbps >= than_kbps + BETTER_BY_KBPS)


async def _find_twin(s: AsyncSession, u: Upload) -> dict | None:
    """Look for the library's track this file is of already: by its sound; where the sound finds nothing — by the
    same names and length, as a download is told to be owned. {track_id, by, likeness}."""
    tags = u.probed_tags_json or {}
    hit = await acoustic.twin(s, await _chroma(s, u), u.duration_s)
    if hit is not None:
        return {"track_id": hit[0].id, "by": "sound", "likeness": round(hit[2], 3)}
    if tags.get("artist") and tags.get("title"):
        track = await find_owned(s, artist=str(tags["artist"]), title=str(tags["title"]),
                                 duration_s=round(u.duration_s) if u.duration_s else None)
        if track is not None:
            return {"track_id": track.id, "by": "name", "likeness": None}
    return None


async def _twin(s: AsyncSession, u: Upload) -> UploadTwin | None:
    """The library's track this file is of already (`_find_twin`), as the form shows it. It is looked for once, when
    the file arrives, and kept with the upload (`_twin` of its tags): a list of uploads does not go through the
    library again. An upload from before that is looked for when it is first shown."""
    tags = dict(u.probed_tags_json or {})
    if "_twin" not in tags:
        if await _chroma(s, u) is None and _abs(u).is_file():
            sound = await acoustic.of_file(_abs(u))
            if sound:
                u.chroma, u.duration_s = sound[0], u.duration_s or sound[1]
                await s.flush()
        tags["_twin"] = await _find_twin(s, u)
        u.probed_tags_json = tags
        await s.flush()
    found = tags.get("_twin")
    track = await s.get(Track, found["track_id"]) if found else None
    if track is None:
        return None
    f = await current_file(s, track.id)
    if f is None:
        return None
    sure = found["by"] == "name" or (found.get("likeness") or 0) >= acoustic.SAME
    return UploadTwin(track_id=track.id, title=track.title, artist=track.artist, album=track.album,
                      codec=f.codec, bitrate_kbps=f.bitrate_kbps, by=found["by"], sure=sure,
                      better=sure and _better(tags.get("codec"), tags.get("bitrate_kbps"), f.codec, f.bitrate_kbps))


async def _chroma(s: AsyncSession, u: Upload) -> bytes | None:
    return (await s.execute(select(Upload.chroma).where(Upload.id == u.id))).scalar_one_or_none()


async def upload_out(s: AsyncSession, u: Upload) -> UploadOut:
    twin = await _twin(s, u) if u.status == "uploaded" else None
    tags = {k: v for k, v in (u.probed_tags_json or {}).items() if not k.startswith("_")}
    return UploadOut(id=u.id, orig_name=u.orig_name, size=u.size, status=u.status, tags=tags,
                     error=u.error, created_at=u.created_at, artists=split_artists(str(tags.get("artist") or "")),
                     codec=tags.get("codec"), bitrate_kbps=tags.get("bitrate_kbps"), twin=twin)


def _upload_dir(user_id: int) -> Path:
    d = get_settings().staging_dir / "uploads" / str(user_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _abs(u: Upload) -> Path:
    return get_settings().staging_dir / Path(u.staging_path)


def _copy_limited(src, dest: Path, limit: int) -> int:
    n = 0
    with dest.open("wb") as out:
        while chunk := src.read(CHUNK):
            n += len(chunk)
            if n > limit:
                raise ValueError("too large")
            out.write(chunk)
    return n


@router.post("", response_model=list[UploadOut])
async def upload(files: list[UploadFile] = File(...), user: User = Depends(current_user),
                 s: AsyncSession = Depends(get_session, scope="function")):
    cfg = get_settings().cfg.uploads
    limit = cfg.max_file_mb * 1024 * 1024
    out = []
    for f in files:
        name = Path(f.filename or "file").name
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext not in cfg.extensions:
            raise HTTPException(415, f"Формат не поддерживается: {name}")
        rel = Path("uploads") / str(user.id) / f"{uuid.uuid4().hex}.{ext}"
        dest = get_settings().staging_dir / rel
        _upload_dir(user.id)
        try:
            size = await asyncio.to_thread(_copy_limited, f.file, dest, limit)
        except ValueError:
            dest.unlink(missing_ok=True)
            raise HTTPException(413, f"Файл больше {cfg.max_file_mb} МБ: {name}") from None
        try:
            tags = await asyncio.to_thread(tagger.read_tags, dest)
        except Exception as e:
            dest.unlink(missing_ok=True)
            raise HTTPException(400, f"Не удалось прочитать файл {name}: {e}") from e
        if not tags.get("title"):
            tags["title"] = name.rsplit(".", 1)[0]
        # what the file is — its codec, its bitrate, its length — and the picture of its sound: by them it is told
        # to be a recording the library has, and whether it is the better file of the two
        try:
            info = await probe.probe(dest)
            tags["codec"], tags["bitrate_kbps"] = info.codec, info.bitrate_kbps
        except Exception as e:
            log.info("upload %s not probed: %r", name, e)
            info = None
        sound = await acoustic.of_file(dest)
        u = Upload(user_id=user.id, staging_path=rel.as_posix(), orig_name=name, size=size,
                   probed_tags_json=json.loads(json.dumps(tags, default=str)),
                   chroma=sound[0] if sound else None,
                   duration_s=(info.duration_s if info else None) or (sound[1] if sound else None))
        s.add(u)
        await s.flush()
        out.append(await upload_out(s, u))
    return out


@router.get("", response_model=list[UploadOut])
async def list_uploads(status: str | None = "uploaded", user: User = Depends(current_user),
                       s: AsyncSession = Depends(get_session, scope="function")):
    stmt = select(Upload).where(Upload.user_id == user.id)
    if status:
        stmt = stmt.where(Upload.status == status)
    rows = list((await s.execute(stmt.order_by(Upload.id.desc()).limit(200))).scalars())
    return [await upload_out(s, u) for u in rows]


async def _own(s: AsyncSession, user: User, upload_id: int) -> Upload:
    u = await s.get(Upload, upload_id)
    if u is None or u.user_id != user.id:
        raise HTTPException(404, "Файл не найден")
    return u


@router.get("/{upload_id}/cover")
async def cover(upload_id: int, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    u = await _own(s, user, upload_id)
    p = _abs(u)
    data = await asyncio.to_thread(tagger.read_cover, p) if p.is_file() else None
    if not data:
        raise HTTPException(404, "Нет обложки")
    return Response(data, media_type="image/jpeg")


@router.delete("/{upload_id}")
async def remove(upload_id: int, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    u = await _own(s, user, upload_id)
    _abs(u).unlink(missing_ok=True)
    u.status = "discarded"
    return {"ok": True}


@router.post("/commit", response_model=UploadCommitOut)
async def commit(payload: str = Form(...), cover: UploadFile | None = File(None), user: User = Depends(current_user),
                 s: AsyncSession = Depends(get_session, scope="function")):
    try:
        body = UploadCommitIn.model_validate_json(payload)
    except ValidationError as e:
        raise HTTPException(422, f"Неверные данные формы: {e.errors()[:3]}") from e
    if not body.tracks:
        raise HTTPException(400, "Не выбраны файлы")

    if body.album.mode == "existing":
        album = await access.need_album(s, user, body.album.album_id or 0)  # one of the listener's own files
    else:
        if not body.album.title or not body.album.album_artist:
            raise HTTPException(400, "Укажите название и исполнителя альбома")
        album = Album(uid=str(uuid.uuid4()), title=body.album.title.strip(),
                      album_artist=body.album.album_artist.strip(), year=body.album.year, genre=body.album.genre,
                      release_type=body.album.release_type or "album", created_by=user.id)
        s.add(album)
        await s.flush()

    cover_bytes: bytes | None = await cover.read() if cover is not None else None
    if not cover_bytes and body.cover_from_upload_id:
        cu = await _own(s, user, body.cover_from_upload_id)
        cover_bytes = await asyncio.to_thread(tagger.read_cover, _abs(cu))

    imported = 0
    track_ids: list[int] = []
    for i, tr in enumerate(body.tracks):
        u = await _own(s, user, tr.upload_id)
        if u.status != "uploaded":
            continue
        src = _abs(u)
        if not src.is_file():
            u.status, u.error = "failed", "файл пропал из staging"
            continue
        try:
            info = await probe.probe(src)
        except Exception as e:
            log.warning("probe failed for upload %s: %r", u.id, e)
            info = None
        # the file of a track the library has (the upload is the better one): it becomes that track's file
        replaced = await s.get(Track, tr.replace_track_id) if tr.replace_track_id else None
        line = tr.artist.strip() or album.album_artist
        spec = ImportSpec(
            artist=line,
            artists=split_artists(line),
            track_id=replaced.id if replaced is not None else None,
            chroma=await _chroma(s, u),
            title=tr.title.strip() or u.orig_name,
            album_id=album.id,
            track_no=tr.track_no or (i + 1),
            disc_no=tr.disc_no or 1,
            genre=tr.genre or album.genre,
            explicit=tr.explicit,
            cover=cover_bytes if i == 0 or cover_bytes else None,
            source="upload",
            source_url=u.orig_name,
            duration_s=round(info.duration_s) if info and info.duration_s else None,
            bitrate_kbps=info.bitrate_kbps if info else None,
            codec=info.codec if info else None,
            added_by=user.id,
        )
        try:
            track = await import_file(s, src, spec)
        except Exception as e:
            log.exception("upload import failed")
            u.status, u.error = "failed", str(e)[:500]
            continue
        u.status, u.track_id = "imported", track.id
        imported += 1
        track_ids.append(track.id)
    await enqueue_scan(s)
    if body.tag_ids and track_ids:
        from app import tags

        await tags.assign_tracks(s, user.id, track_ids, body.tag_ids)
    playlist_ids = list(dict.fromkeys([*([body.playlist_id] if body.playlist_id else []), *body.playlist_ids]))
    if playlist_ids and track_ids:  # the playlists are the Hub's: the tracks are in them at once
        from app import playlists
        from app.playlists_mirror import enqueue_mirror

        for pid in playlist_ids:
            p = await playlists.own(s, user.id, int(pid)) if str(pid).isdigit() else None
            if p is not None and p.kind == playlists.USER and await playlists.add(s, p, track_ids):
                await enqueue_mirror(s, p.id)
    if body.star and track_ids:
        from app.api.schemas import FavoriteTarget
        from app.favorites import command, project_liked

        # the like is the track's own: Navidrome gets the ♥ when its scan has found the file (`deliver_pending`)
        await command(s, user, [FavoriteTarget(track_id=t) for t in track_ids], liked=True, client="hub",
                      context="upload")
        await project_liked(s, user.id)
    await s.commit()
    notify()
    bus.publish(user.id, "library", {"kind": "imported", "album_id": album.id})
    return UploadCommitOut(album_id=album.id, imported=imported)


def purge_stale_uploads(days: int = 7) -> int:
    """Remove staged upload files never committed (called by the daily housekeeping)."""
    import time

    root = get_settings().staging_dir / "uploads"
    if not root.is_dir():
        return 0
    cutoff = time.time() - days * 86400
    n = 0
    for p in root.rglob("*"):
        if p.is_file() and p.stat().st_mtime < cutoff:
            p.unlink(missing_ok=True)
            n += 1
    shutil.rmtree(root / "_tmp", ignore_errors=True)
    return n
