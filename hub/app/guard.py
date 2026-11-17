"""A guesser of passwords is slowed down.

Signing in checks a password against Navidrome, as often as it is asked — so the Hub counts the wrong ones itself:
by where they come from (an address that keeps guessing) and by the name they are for (many addresses guessing one
account). Past the limit the answer is «wait», whatever the password; the count is of the last ten minutes and lives
in memory — a restart forgets it, a guesser gains nothing by that.

The address is the one the proxy in front of the Hub names (uvicorn's --proxy-headers): Caddy writes the caller's
own address there, whatever the caller claims. An address of a home network is not counted by: it is the home
itself — or Docker Desktop, which shows every caller from outside as its own gateway, so that a count by it would
shut everybody out for one guesser. There the count by the name is the whole of the guard.

Other players (`/rest`, app/api/subsonic.py) send the sign-in with every call; they are counted the same way, in the
same counts.
"""

from __future__ import annotations

import ipaddress
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


def _outside(address: str | None) -> bool:
    try:
        return ipaddress.ip_address(address or "").is_global
    except ValueError:
        return False


def _keys(address: str | None, name: str) -> list[tuple[str, int]]:
    by_name = (f"n:{name.strip().casefold()}", PER_NAME)
    return [(f"a:{address}", PER_ADDRESS), by_name] if _outside(address) else [by_name]


WAIT = "Слишком много неверных попыток. Подождите десять минут"


def shut(address: str | None, name: str) -> bool:
    """Before a password is looked at: there were too many wrong ones, the answer is «wait»."""
    if len(_wrong) > 10_000:  # the addresses that guessed long ago
        for key in [k for k in _wrong if not _recent(k)]:
            del _wrong[key]
    return any(len(_recent(key)) >= limit for key, limit in _keys(address, name))


def check(address: str | None, name: str) -> None:
    """`shut`, as an answer of the Hub's own API: raises 429."""
    if shut(address, name):
        raise HTTPException(429, WAIT)


def wrong(address: str | None, name: str) -> None:
    now = time.monotonic()
    for key, _ in _keys(address, name):
        _recent(key).append(now)


def right(name: str) -> None:
    """The account's owner got in: what was guessed at the name is forgotten (not what an address guessed)."""
    _wrong.pop(f"n:{name.strip().casefold()}", None)
