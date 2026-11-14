"""Who is credited on a track, out of a line of names.

A file's tag says «Три дня дождя, Роки» in one line; they are two artists, and the first is whose album it is. A
track keeps its line as it is shown; this reads the names out of it — to write them into the file one by one (the
`ARTISTS` tag an app reads them by) and to know the album's artist where the file names none: a guest on one track
must not make that track an album of its own.

A comma is not always between two artists: a name that goes on after it with «the …» or «and …» is one («Tyler,
The Creator»). The rest cannot be told from the line alone («Earth, Wind & Fire» is one band, «A, B & C» may be
three): what the reading gets wrong is put right in the form.
"""

from __future__ import annotations

import re

_FEAT = re.compile(r"\s+(?:feat\.?|ft\.?|featuring)\s+", re.I)
_GOES_ON = re.compile(r"^(?:the|and|&)\b", re.I)


def split_artists(line: str | None) -> list[str]:
    """The artists of a line, in its order, each once."""
    out: list[str] = []
    for chunk in _FEAT.split((line or "").strip()):
        parts = [p.strip() for p in chunk.split(",")]
        merged: list[str] = []
        for p in parts:
            if not p:
                continue
            if merged and (_GOES_ON.match(p) or re.search(r"(?:&|\band)\s*$", merged[-1], re.I)):
                merged[-1] = f"{merged[-1]}, {p}"  # the comma was inside a name
            else:
                merged.append(p)
        for name in merged:
            if name.casefold() not in {x.casefold() for x in out}:
                out.append(name)
    return out


def main_artist(line: str | None) -> str:
    """The first of them: whose track it is, and — where nothing else says — whose album."""
    names = split_artists(line)
    return names[0] if names else (line or "").strip()
