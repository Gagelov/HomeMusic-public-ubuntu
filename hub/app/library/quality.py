"""How good a file is, as far as its codec and bitrate say.

Two files of one recording are compared here — an upload and the library's file, a file and the one found to take
its place — and a file is called weak here, so that every place says the same. A file without losses is over any
with them. Among those with losses the codec counts: Opus at 128 is heard as an MP3 at about 200, AAC at 128 as an
MP3 at about 170 — so each bitrate is brought to what an MP3 would need for the same sound.
"""

from __future__ import annotations

LOSSLESS = {"flac", "alac", "wav", "pcm_s16le", "pcm_s24le", "aiff", "ape", "wavpack", "wv"}
AS_MP3 = {"opus": 1.6, "aac": 1.3, "vorbis": 1.3, "m4a": 1.3}  # a bitrate of the codec, as an MP3's
BETTER_BY = 48  # of that measure: less is not worth changing a file for
WEAK_UNDER = 192  # of that measure: an MP3 at 128–160, an Opus under 120


def rank(codec: str | None, kbps: int | None) -> int | None:
    """The file's bitrate as an MP3's (None: not known; a file without losses: far over any)."""
    c = (codec or "").lower()
    if c in LOSSLESS:
        return 10_000
    return round(kbps * AS_MP3.get(c, 1.0)) if kbps else None


def better(codec: str | None, kbps: int | None, than_codec: str | None, than_kbps: int | None) -> bool:
    """The first file is the better of the two — by enough to put it in the other's place."""
    a, b = rank(codec, kbps), rank(than_codec, than_kbps)
    if a is None or b is None or b >= 10_000:
        return False
    return a >= 10_000 or a >= b + BETTER_BY


def weak(codec: str | None, kbps: int | None) -> bool:
    """A file that is heard to be poor. One whose bitrate is not known is not called so."""
    r = rank(codec, kbps)
    return r is not None and r < WEAK_UNDER
