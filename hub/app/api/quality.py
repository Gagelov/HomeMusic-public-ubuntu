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
    sure: bool = False  # by the sound it is the same recording (though the two files may differ in length or at places)
    better: bool = False  # the file found is the better one of the two: there is something to replace the track's with
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
    from app.library import acoustic, quality
    from app.library.tracks import current_files

    files = await current_files(s, [t.id for row, t, _ in rows if row.state == "found"])
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
            sure=row.likeness is not None and row.likeness >= acoustic.SAME,
            better=row.state == "found" and (f := files.get(t.id)) is not None and quality.better(row.codec, row.bitrate_kbps, f.codec, f.bitrate_kbps),
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
async def accept(row_id: int, file: bool | None = None, user: User = Depends(current_user),
                 s: AsyncSession = Depends(get_session, scope="function")) -> dict:
    """Yes. `file`: the file found takes the place of the track's own — said apart for «is it that record?», where
    yes by itself is of the record only and the track keeps its file; a better file found for a weak one is taken."""
    row = await _row(s, user, row_id)
    try:
        await upgrade.accept(s, row, user.id, take_file=bool(file) if row.kind == "identify" else True)
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


@router.post("/{row_id}/version")
async def version(row_id: int, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")) -> dict:
    """The third answer to «is it that record?»: another version of the same song — the track stays as it is, and
    the two are tied as versions."""
    row = await _row(s, user, row_id)
    try:
        await upgrade.other_version(s, user.id, row)
    except ValueError as e:
        raise HTTPException(409, str(e)) from e
    await s.commit()
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
    from app.library import acoustic

    row = await _row(s, user, row_id)
    out: dict = {}
    paths = {}
    for which in ("current", "found", "was"):
        try:
            paths[which] = await _file(s, row, which)
            out[which] = await upgrade.peaks(paths[which])
        except HTTPException:
            out[which] = []
    # where the two files heard side by side part: the upper one's moments (`at`…`to`) and the lower one's
    # (`other_at`…`other_to`), and which of them falls quiet there — «upper» / «lower»
    upper, lower = ("was", "current") if "was" in paths else ("current", "found")
    gaps = await acoustic.differences(paths[upper], paths[lower]) if upper in paths and lower in paths else []
    out["gaps"] = [{**g, "quieter": {"mine": "upper", "other": "lower"}.get(g.get("quieter"))} for g in gaps]
    whole = {w: await acoustic.of_whole(paths[w]) for w in (upper, lower) if w in paths}
    out["length"] = {w: (v[1] if v else None) for w, v in whole.items()}
    return out


# --- another file for a track, picked by the listener ------------------------------------------------------------


class TrackFileOut(BaseModel):
    """A track of the library and the file it plays from, as «Найти другой файл» shows it."""

    track_id: int
    title: str
    artist: str
    duration_s: int | None = None
    cover_url: str | None = None
    explicit: bool | None = None
    codec: str | None = None
    bitrate_kbps: int | None = None
    source: str | None = None
    name: str | None = None  # the file's own name


class PickIn(BaseModel):
    """A file to weigh or to take: one the search showed (`ref`: "file:<provider>:<id>") or the page of a track at
    a source (`url`). `sure`: take it though it does not sound like the track's own."""

    ref: str | None = Field(default=None, max_length=300)
    url: str | None = Field(default=None, max_length=2048)
    sure: bool = False


class PickOut(BaseModel):
    likeness: float | None = None  # how alike it sounds to the track's own file, 0…1 (None: not told)
    verdict: str  # same / alike / other / unknown
    codec: str | None = None
    bitrate_kbps: int | None = None
    duration_s: int | None = None
    better: bool = False  # the better file of the two
    taken: bool = False  # it is the track's file now
    # where the two part though they are one recording: the track's file's moments, and which falls quiet there
    # («mine» — the track's own, «other» — this one): the places a censor's cut shows as
    gaps: list[dict] = []
    # the file as it lies on the Hub for now: what it is heard by (`…/picked/<key>/audio`), who its source says
    # it is, and the loudness of the two along their lengths (the lanes they are moved through by)
    key: str | None = None
    title: str | None = None
    artist: str | None = None
    provider: str | None = None
    peaks: dict[str, list[int]] = {}
    length: dict[str, float | None] = {}


async def _track_and_file(s: AsyncSession, track_id: int) -> tuple[Track, TrackFile]:
    t = await s.get(Track, track_id)
    f = await current_file(s, track_id) if t is not None else None
    if t is None or f is None:
        raise HTTPException(404, "У трека нет файла в библиотеке")
    return t, f


@router.get("/track/{track_id}", response_model=TrackFileOut)
async def track_file(track_id: int, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    t, f = await _track_and_file(s, track_id)
    return TrackFileOut(track_id=t.id, title=t.title, artist=t.artist, duration_s=t.duration_s, cover_url=_cover(t),
                        explicit=t.explicit, codec=f.codec, bitrate_kbps=f.bitrate_kbps, source=f.source,
                        name=f.path.rsplit("/", 1)[-1])


@router.get("/track/{track_id}/audio")
async def track_audio(track_id: int, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    """The file the track plays from, to hear it beside the ones found."""
    _, f = await _track_and_file(s, track_id)
    path = library_abs(f.path)
    if not path.is_file():
        raise HTTPException(404, "Файла нет")
    return FileResponse(path, headers={"Cache-Control": "no-store"})


async def _fetch_pick(body: PickIn, t: Track):
    """The file a pick names, on the Hub's disk (kept for a while: weighed first, taken after): (path, candidate)."""
    import hashlib

    from app import listen
    from app.api.downloads import candidate_from_url
    from app.config import get_settings
    from app.providers.base import TrackQuery
    from app.services import svc

    if body.url:
        cand = await candidate_from_url(body.url, TrackQuery(artist=t.artist, title=t.title))
    elif body.ref:
        try:
            cand = (await listen.choose(body.ref)).candidate
        except listen.ListenError as e:
            raise HTTPException(e.status, str(e)) from e
    else:
        raise HTTPException(400, "Не указан файл")
    provider = svc.providers.get(cand.provider) if cand is not None else None
    if cand is None or provider is None:
        raise HTTPException(404, "Файл не найден: повторите поиск")
    key = hashlib.md5(f"{cand.provider}:{cand.provider_id}".encode()).hexdigest()[:16]
    folder = get_settings().staging_dir / "picks" / key
    have = [p for p in folder.glob("*") if p.is_file()] if folder.is_dir() else []
    if have:
        return have[0], cand
    folder.mkdir(parents=True, exist_ok=True)
    try:
        return await provider.fetch(cand, folder), cand
    except Exception as e:
        raise HTTPException(502, f"Источник не отдал файл: {e}") from e


async def _weigh(s: AsyncSession, t: Track, f: TrackFile, body: PickIn):
    from app.library import acoustic, probe, quality

    path, cand = await _fetch_pick(body, t)
    try:
        info = await probe.probe(path)
    except Exception:
        info = None
    alike = await upgrade.likeness_to(s, t.id, path)
    codec, kbps = (info.codec, info.bitrate_kbps) if info else (None, cand.bitrate_kbps)
    verdict = "unknown" if alike is None else "same" if alike >= acoustic.SAME else "alike" if alike >= acoustic.ALIKE else "other"
    gaps = await acoustic.differences(library_abs(f.path), path) if verdict == "same" else []
    out = PickOut(likeness=alike, verdict=verdict, codec=codec, bitrate_kbps=kbps,
                  duration_s=round(info.duration_s) if info and info.duration_s else cand.duration_s,
                  better=quality.better(codec, kbps, f.codec, f.bitrate_kbps), gaps=gaps, key=path.parent.name,
                  title=cand.title, artist=cand.artist, provider=cand.provider,
                  peaks={"mine": await upgrade.peaks(library_abs(f.path)), "other": await upgrade.peaks(path)},
                  length={"mine": float(t.duration_s) if t.duration_s else None,
                          "other": float(info.duration_s) if info and info.duration_s else None})
    return out, path, cand, info


@router.post("/track/{track_id}/weigh", response_model=PickOut)
async def weigh(track_id: int, body: PickIn, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    """Download a file found for the track and say how it compares with the track's own: by the sound, and as a file."""
    t, f = await _track_and_file(s, track_id)
    return (await _weigh(s, t, f, body))[0]


@router.get("/picked/{key}/audio")
async def picked_audio(key: str, user: User = Depends(current_user)):
    """A file downloaded to be weighed (`weigh`), to hear it beside the track's own."""
    from app.config import get_settings

    folder = get_settings().staging_dir / "picks" / key
    have = [x for x in folder.glob("*") if x.is_file()] if key.isalnum() and folder.is_dir() else []
    if not have:
        raise HTTPException(404, "Файла уже нет: найдите его заново")
    return FileResponse(have[0], headers={"Cache-Control": "no-store"})


@router.post("/track/{track_id}/take", response_model=PickOut)
async def take(track_id: int, body: PickIn, user: User = Depends(current_user), s: AsyncSession = Depends(get_session, scope="function")):
    """Put the picked file in the place of the track's own. One that does not sound like the same recording is taken
    only when the listener says so (`sure`): 409 says how alike it is."""
    import shutil

    t, f = await _track_and_file(s, track_id)
    out, path, cand, info = await _weigh(s, t, f, body)
    if out.verdict != "same" and not body.sure:
        raise HTTPException(409, {"likeness": out.likeness, "verdict": out.verdict})
    folder = path.parent
    await upgrade.take_picked(s, user.id, t, path, codec=out.codec, bitrate_kbps=out.bitrate_kbps, provider=cand.provider,
                              source_url=cand.page_url, duration_s=info.duration_s if info else None, likeness=out.likeness)
    shutil.rmtree(folder, ignore_errors=True)
    await enqueue_scan(s)
    await s.commit()
    notify()
    bus.publish(user.id, "library", {"kind": "imported", "track_id": t.id})
    out.taken = True
    return out
