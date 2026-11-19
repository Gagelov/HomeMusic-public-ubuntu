"""Playback on the Yandex Station Lite.

The station runs a small token-protected HTTP API (`hm-api.sh` in
station/homemusic).  These routes keep the token on the Hub and let the PWA
choose the station as its output without exposing the station API to the
browser.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

from app.auth import current_user
from app.config import get_settings
from app.models import User

router = APIRouter(tags=["station"])

ACTIONS = {"next", "prev", "pause", "resume", "stop", "like", "dislike", "seek", "volume"}


class StationTrackIn(BaseModel):
    id: str
    artist: str = ""
    title: str = ""
    duration: float = 0


class StationPlayIn(BaseModel):
    index: int = Field(default=0, ge=0)
    position: float = Field(default=0, ge=0)
    tracks: list[StationTrackIn] = Field(min_length=1)


class StationCommandIn(BaseModel):
    action: str
    position: float | None = None
    value: int | None = None


async def _call(
    method: str,
    path: str,
    body: dict | None = None,
    station_url: str | None = None,
    station_token: str | None = None,
) -> dict:
    settings = get_settings()
    url = (station_url or settings.station_url or "").strip().rstrip("/")
    token = (station_token or settings.station_token or "").strip()
    if not url:
        raise HTTPException(status_code=503, detail="Station URL is not configured (set it in the app)")
    if not token:
        raise HTTPException(status_code=401, detail="Station token is not configured (set it in the app)")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(status_code=400, detail="Station URL must be http(s)")
    try:
        async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
            response = await client.request(
                method, url + path, json=body, headers={"X-HM-Token": token}
            )
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Station is unreachable: {exc}") from exc
    if response.status_code >= 400:
        raise HTTPException(status_code=response.status_code, detail=response.text[:300])
    try:
        return response.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="Station returned invalid JSON") from exc


@router.get("/api/station/status")
async def station_status(
    user: User = Depends(current_user),
    station_url: str | None = Header(default=None, alias="X-HM-Station-URL"),
    station_token: str | None = Header(default=None, alias="X-HM-Station-Token"),
):
    return await _call("GET", "/status", None, station_url, station_token)


@router.post("/api/station/command")
async def station_command(
    body: StationCommandIn,
    user: User = Depends(current_user),
    station_url: str | None = Header(default=None, alias="X-HM-Station-URL"),
    station_token: str | None = Header(default=None, alias="X-HM-Station-Token"),
):
    action = body.action.strip().lower()
    if action not in ACTIONS:
        raise HTTPException(status_code=400, detail="Unknown station action")
    return await _call("POST", "/command", body.model_dump(exclude_none=True), station_url, station_token)


@router.post("/api/station/play")
async def station_play(
    body: StationPlayIn,
    user: User = Depends(current_user),
    station_url: str | None = Header(default=None, alias="X-HM-Station-URL"),
    station_token: str | None = Header(default=None, alias="X-HM-Station-Token"),
):
    return await _call("POST", "/play", body.model_dump(), station_url, station_token)
