"""A guesser of passwords is slowed down.

Signing in checks a password against Navidrome, as often as it is asked — so the Hub counts the wrong ones itself:
by where they come from (an address that keeps guessing) and by the name they are for (many addresses guessing one
account). Past the limit the answer is «wait», whatever the password; the count is of the last ten minutes and lives
in memory — a restart forgets it, a guesser gains nothing by that.

The address is the one the proxy in front of the Hub names (uvicorn's --proxy-headers): Caddy writes the caller's
own address there, whatever the caller claims.
"""

from __future__ import annotations

import time
from collections import deque

from fastapi import HTTPException

WINDOW_S = 600
PER_ADDRESS = 10  # wrong passwords from one address in the window
PER_NAME = 30  # ... and for one account, from anywhere

_wrong: dict[str, deque[float]] = {}


def _recent(key: str) -> deque[float]:
    q = _wrong.setdefault(key, deque())
    now = time.monotonic()
    while q and now - q[0] > WINDOW_S:
        q.popleft()
    return q


def _keys(address: str | None, name: str) -> tuple[tuple[str, int], tuple[str, int]]:
    return (f"a:{address or '?'}", PER_ADDRESS), (f"n:{name.strip().casefold()}", PER_NAME)


def check(address: str | None, name: str) -> None:
    """Before a password is looked at: raises 429 when there were too many wrong ones."""
    if len(_wrong) > 10_000:  # the addresses that guessed long ago
        for key in [k for k in _wrong if not _recent(k)]:
            del _wrong[key]
    for key, limit in _keys(address, name):
        if len(_recent(key)) >= limit:
            raise HTTPException(429, "Слишком много неверных попыток. Подождите десять минут")


def wrong(address: str | None, name: str) -> None:
    now = time.monotonic()
    for key, _ in _keys(address, name):
        _recent(key).append(now)


def right(name: str) -> None:
    """The account's owner got in: what was guessed at the name is forgotten (not what an address guessed)."""
    _wrong.pop(f"n:{name.strip().casefold()}", None)
