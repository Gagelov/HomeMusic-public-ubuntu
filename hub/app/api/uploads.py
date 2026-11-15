"""Uploads of own audio files from the phone (FR-5): stream to staging → edit tags → import into an album."""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.schemas import UploadCommitIn, UploadCommitOut, UploadMatch, UploadMatchIn, UploadOut, UploadTwin
from app.auth import current_user
from app.config import get_settings
from app.db import get_session
from app.events import bus
from app.jobs.downloads import enqueue_scan
from app.jobs.queue import notify
from app.library import acoustic, probe, quality, recognize, tagger
from app.library.credits import main_artist, split_artists
from app.library.owned import find_owned
from app.library.tracks import current_file
from app.library.importer import ImportSpec, import_file
from app.models import Track, Upload, User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

CHUNK = 1024 * 1024


_better = quality.better


def _match(tags: dict) -> UploadMatch | None:
    """What the file was told to be (`_match` of its tags), as the form shows it."""
    m = tags.get("_match")
    if not m:
        return None
    meta = m.get("meta") or {}
    return UploadMatch(state=m["state"], why=m.get("why"), by_hand=bool(m.get("by_hand")), ref=meta.get("track_ref"),
                       title=meta.get("title"), artist=meta.get("artist"), artists=meta.get("artists") or [],
                       album=meta.get("album"), album_artist=meta.get("album_artist"), record_type=meta.get("record_type"),
                       year=meta.get("year") or (int(str(meta["release_date"])[:4]) if meta.get("release_date") else None),
                       duration_s=meta.get("duration_s"), cover_url=meta.get("cover_url"))


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
    kept = u.probed_tags_json or {}
    tags = {k: v for k, v in kept.items() if not k.startswith("_")}
    artist, title = recognize.names_of(tags, u.orig_name)
    return UploadOut(id=u.id, orig_name=u.orig_name, size=u.size, status=u.status, tags=tags,
                     error=u.error, created_at=u.created_at, artists=split_artists(artist),
                     codec=tags.get("codec"), bitrate_kbps=tags.get("bitrate_kbps"), twin=twin, match=_match(kept),
                     weak=quality.weak(tags.get("codec"), tags.get("bitrate_kbps")), title=title, artist=artist,
                     single=recognize.single_album(tags.get("album"), title), duration_s=u.duration_s)


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
        # what the file is — its codec, its bitrate, its length — and the picture of its sound: by them it is told
        # to be a recording the library has, and whether it is the better file of the two
        try:
            info = await probe.probe(dest)
            tags["codec"], tags["bitrate_kbps"] = info.codec, info.bitrate_kbps
        except Exception as e:
            log.info("upload %s not probed: %r", name, e)
            info = None
        sound = await acoustic.of_file(dest)
        duration = (info.duration_s if info else None) or (sound[1] if sound else None)
        tags["_match"] = await recognize.of_file(tags, name, duration)
        u = Upload(user_id=user.id, staging_path=rel.as_posix(), orig_name=name, size=size,
                   probed_tags_json=json.loads(json.dumps(tags, default=str)),
                   chroma=sound[0] if sound else None,
                   duration_s=duration)
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
    rows = list((await s.execute(stmt.order_by(Upload.id).limit(5000))).scalars())
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


@router.post("/{upload_id}/match", response_model=UploadOut)
async def match(upload_id: int, body: UploadMatchIn, user: User = Depends(current_user),
                s: AsyncSession = Depends(get_session, scope="function")):
    """Which record of the catalog the file is: the one picked by hand (`ref`), or looked for again."""
    u = await _own(s, user, upload_id)
    tags = dict(u.probed_tags_json or {})
    try:
        tags["_match"] = await recognize.of_ref(body.ref) if body.ref else await recognize.of_file(tags, u.orig_name, u.duration_s)
    except ValueError as e:
        raise HTTPException(404, str(e)) from e
    except Exception as e:
        raise HTTPException(502, f"Каталог не ответил: {e}") from e
    u.probed_tags_json = json.loads(json.dumps(tags, default=str))
    await s.flush()
    return await upload_out(s, u)


@router.delete("/{upload_id}")
async def remove(upload_id: int, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    u = await _own(s, user, upload_id)
    _abs(u).unlink(missing_ok=True)
    u.status = "discarded"
    return {"ok": True}


def _own_spec(u: Upload, tr, tags: dict) -> ImportSpec:
    """The file under its own names, as the form has them: an «album» that is no album makes a single."""
    title = tr.title.strip() or recognize.names_of(tags, u.orig_name)[1]
    line = tr.artist.strip() or recognize.names_of(tags, u.orig_name)[0] or "Неизвестный исполнитель"
    single = recognize.single_album(tr.album, title)
    return ImportSpec(
        artist=line, artists=split_artists(line), title=title,
        album=title if single else " ".join((tr.album or "").split()),
        album_artist=(tr.album_artist or "").strip() or main_artist(line),
        year=tr.year, release_type="single" if single else (tags.get("release_type") or "album"),
        track_no=1 if single else (tr.track_no or tags.get("track_no")), disc_no=1 if single else (tags.get("disc_no") or 1),
        genre=tags.get("genre"), isrc=tags.get("isrc"), explicit=tags.get("explicit"),
    )


async def _catalog_spec(meta: dict) -> ImportSpec:
    """The file as the song of the catalog it is: what a download of that song would be filed as."""
    from app.jobs.downloads import _parse_date, fetch_cover

    released = _parse_date(meta.get("release_date"))
    single = not meta.get("album")
    ref = str(meta.get("track_ref") or "")
    return ImportSpec(
        artist=meta.get("artist") or "", title=meta.get("title") or "", artists=meta.get("artists") or [],
        album=meta.get("album") or meta.get("title"), album_artist=meta.get("album_artist") or meta.get("artist"),
        year=meta.get("year") or (released.year if released else None), release_date=released,
        release_type={"compile": "compilation"}.get(meta.get("record_type", ""), meta.get("record_type"))
        or ("single" if single else "album"),
        track_no=meta.get("track_no") or (1 if single else None), track_total=meta.get("track_total"),
        disc_no=meta.get("disc_no") or 1, genre=meta.get("genre"), isrc=meta.get("isrc"), explicit=meta.get("explicit"),
        deezer_track_id=meta.get("deezer_track_id"), ref=ref or None, deezer_album_id=meta.get("deezer_album_id"),
        upc=meta.get("upc"), cover=await fetch_cover(meta.get("cover_url")),
    )


@router.post("/commit", response_model=UploadCommitOut)
async def commit(body: UploadCommitIn, user: User = Depends(current_user),
                 s: AsyncSession = Depends(get_session, scope="function")):
    """Bring the files into the library, each as what it is: the song of the catalog it was told to be, or under
    its own names. The album is the song's own (found or made by its name and artist), not the form's."""
    if not body.tracks:
        raise HTTPException(400, "Не выбраны файлы")
    imported = 0
    track_ids: list[int] = []
    album_ids: list[int] = []
    for tr in body.tracks:
        u = await _own(s, user, tr.upload_id)
        if u.status != "uploaded":
            continue
        src = _abs(u)
        if not src.is_file():
            u.status, u.error = "failed", "файл пропал из staging"
            continue
        tags = u.probed_tags_json or {}
        meta = (tags.get("_match") or {}).get("meta") if tr.catalog else None
        try:
            info = await probe.probe(src)
        except Exception as e:
            log.warning("probe failed for upload %s: %r", u.id, e)
            info = None
        spec = await _catalog_spec(meta) if meta else _own_spec(u, tr, tags)
        if spec.cover is None:  # the catalog has no picture, or the file is filed under its own names: the file's
            spec.cover = await asyncio.to_thread(tagger.read_cover, src)
        # the file of a track the library has (the upload is the better one): it becomes that track's file
        replaced = await s.get(Track, tr.replace_track_id) if tr.replace_track_id else None
        spec.track_id = replaced.id if replaced is not None else None
        spec.chroma = await _chroma(s, u)
        spec.source, spec.source_url, spec.added_by = "upload", u.orig_name, user.id
        spec.duration_s = round(info.duration_s) if info and info.duration_s else None
        spec.bitrate_kbps, spec.codec = (info.bitrate_kbps, info.codec) if info else (None, None)
        try:
            track = await import_file(s, src, spec)
        except Exception as e:
            log.exception("upload import failed")
            u.status, u.error = "failed", str(e)[:500]
            continue
        u.status, u.track_id = "imported", track.id
        imported += 1
        track_ids.append(track.id)
        if track.album_id and track.album_id not in album_ids:
            album_ids.append(track.album_id)
    await enqueue_scan(s)
    if body.tag_ids and track_ids:
        from app import tags

        await tags.assign_tracks(s, user.id, track_ids, body.tag_ids)
    playlist_ids = list(dict.fromkeys(body.playlist_ids))
    if (playlist_ids or body.keep_in) and track_ids:  # the playlists are the Hub's: the tracks are in them at once
        from app import playlists
        from app.playlists_mirror import enqueue_mirror

        if body.keep_in and body.keep_in.strip():
            playlist_ids.append(str((await playlists.named(s, user.id, body.keep_in)).id))
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
    upgrading = 0
    if body.upgrade and track_ids:
        from app.library import upgrade

        upgrading = await upgrade.enqueue(s, user.id, track_ids)
    await s.commit()
    notify()
    bus.publish(user.id, "library", {"kind": "imported", "album_id": album_ids[0] if album_ids else None})
    return UploadCommitOut(album_ids=album_ids, imported=imported, upgrading=upgrading)


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
