"""Whether two files are the same recording, told by their sound.

Names lie both ways: one song comes as «Марафоны» and as «Marafony (feat. Роки)», and two recordings of one name
and length — the album's and a re-recording — are not the same. The sound does not: Chromaprint (`fpcalc`, a
program on the Hub; nothing goes anywhere, no service is asked) draws a compact picture of a file's first two
minutes that stays almost the same whatever the file is encoded with — an MP3 at 128 and a FLAC of one recording
differ in a few bits of it, two recordings in half.

A file's picture is kept with it (`track_files.chroma`, an upload's `uploads.chroma`): made when the file arrives,
and for the files that were there before by a pass in the background (`fill`). `twin` finds the library's file
that is the same recording as a new one — among the tracks of about its length, so a library is not gone through
whole.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from array import array
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import undefer

from app.models import Track, TrackFile

log = logging.getLogger(__name__)

LENGTH_S = 120  # of the file's start that is listened to
# The share of bits two pictures agree in. Measured on a library of 700 files, 17 679 pairs of about one length: two
# recordings agree in 0.4–0.6 (all but eleven pairs); one recording encoded twice — 0.99; and between them stand the
# recordings made over one backing track — a song's version in English 0.86, a cover over the original's music 0.82.
# So «the same recording» is a high bar, and what is only alike is said to be alike, not the same.
SAME = 0.93
ALIKE = 0.80
SHIFT = 80  # frames (≈ 10 s) one file may start later than the other: silence before the music, a cut intro
MIN_OVERLAP = 160  # frames (≈ 20 s) compared at the least
NEAR_S = 8  # a twin is looked for among tracks whose length differs by no more than this
TIMEOUT_S = 60


def available() -> bool:
    return shutil.which("fpcalc") is not None


def pack(values: list[int]) -> bytes:
    return array("I", [v & 0xFFFFFFFF for v in values]).tobytes()


def unpack(data: bytes | None) -> list[int]:
    if not data:
        return []
    a = array("I")
    a.frombytes(data[: len(data) - len(data) % a.itemsize])
    return list(a)


async def of_file(path: Path) -> tuple[bytes, float] | None:
    """The picture of the file's sound and the file's length; None: there is no `fpcalc`, or it could not read the
    file."""
    if not available():
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            "fpcalc", "-raw", "-json", "-length", str(LENGTH_S), str(path),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), TIMEOUT_S)
        body = json.loads(out or b"{}")
        values = body.get("fingerprint") or []
        if not isinstance(values, list) or len(values) < MIN_OVERLAP // 2:
            return None
        return pack([int(v) for v in values]), float(body.get("duration") or 0)
    except Exception as e:
        log.info("fpcalc %s: %r", path.name, e)
        return None


def likeness(a: list[int] | bytes, b: list[int] | bytes) -> float:
    """How alike two pictures are, 0…1: the share of bits that agree where they overlap, at the shift at which they
    agree most. Each picture is taken as one long number, so a shift is a shift of bits and the count of the bits
    that differ is one operation — a pair is compared in a fraction of a millisecond, a library in a second."""
    ab = a if isinstance(a, bytes) else pack(a)
    bb = b if isinstance(b, bytes) else pack(b)
    na, nb = len(ab) // 4, len(bb) // 4
    if not na or not nb:
        return 0.0
    x, y = int.from_bytes(ab[: na * 4], "little"), int.from_bytes(bb[: nb * 4], "little")
    need = min(MIN_OVERLAP, min(na, nb) * 3 // 4)
    best = 0.0
    for shift in range(-SHIFT, SHIFT + 1):
        if shift >= 0:
            n, u, v = min(na - shift, nb), x >> (32 * shift), y
        else:
            n, u, v = min(na, nb + shift), x, y >> (32 * -shift)
        if n < need or n <= 0:
            continue
        wrong = ((u ^ v) & ((1 << (32 * n)) - 1)).bit_count()
        best = max(best, 1.0 - wrong / (32.0 * n))
        if best > 0.98:
            break
    return best


async def twin(s: AsyncSession, chroma: bytes | None, duration_s: float | None) -> tuple[Track, TrackFile, float] | None:
    """The library's file that sounds like this picture: (its track, the file, how alike) — the likest of them,
    when it is alike at least `ALIKE`. `SAME` and over is the same recording; between the two it is a recording
    over the same music (a version in another language, a cover over the original's backing)."""
    if not chroma:
        return None
    q = select(Track, TrackFile).join(TrackFile, TrackFile.track_id == Track.id).where(TrackFile.chroma.is_not(None))
    if duration_s:
        q = q.where(Track.duration_s.is_(None) | Track.duration_s.between(int(duration_s) - NEAR_S, int(duration_s) + NEAR_S))
    rows = (await s.execute(q.options(undefer(TrackFile.chroma)).order_by(TrackFile.id.desc()))).all()

    def best() -> tuple[int, float]:
        at, top = -1, 0.0
        for i, (_, f) in enumerate(rows):
            v = likeness(chroma, f.chroma or b"")
            if v > top:
                at, top = i, v
        return at, top

    at, top = await asyncio.to_thread(best)
    return (rows[at][0], rows[at][1], top) if at >= 0 and top >= ALIKE else None


async def fill(s: AsyncSession, limit: int = 100) -> int:
    """Draw the pictures of the library's files that have none yet (the ones there before the Hub drew them), the
    newest first. Returns how many were drawn; a file that cannot be read is marked so it is not tried again."""
    if not available():
        return 0
    files = list((await s.execute(select(TrackFile).where(TrackFile.chroma.is_(None)).order_by(TrackFile.id.desc())
                                  .limit(limit))).scalars())
    n = 0
    for f in files:
        from app.library.importer import library_abs

        got = await of_file(library_abs(f.path))
        f.chroma = got[0] if got else b""  # empty: tried, nothing to draw
        n += 1 if got else 0
    await s.flush()
    return n
