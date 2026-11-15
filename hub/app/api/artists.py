"""An artist's name, spellings and other projects (app/library/artists.py), as the pages change them."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import current_user
from app.db import get_session
from app.events import bus
from app.jobs.queue import enqueue, notify
from app.library import artists
from app.models import Artist, User

router = APIRouter(prefix="/api/artists", tags=["artists"])


class ArtistNameOut(BaseModel):
    id: int
    name: str
    source: str  # catalog / library / manual
    main: bool = False


class ArtistProjectOut(BaseModel):
    id: int
    name: str
    ref: str | None = None  # the catalog's page of the project (none: only the name leads to it)
    also: list[str] = []


class ArtistPickOut(BaseModel):
    id: int
    name: str


class ArtistCardOut(BaseModel):
    """An artist as the Hub knows them: the one name, the other spellings, the projects linked, and who looks like
    the same artist under another spelling. `rewriting`: the library is being written in the name just now."""

    id: int
    name: str
    names: list[ArtistNameOut] = []
    projects: list[ArtistProjectOut] = []
    suggestions: list[ArtistPickOut] = []
    rewriting: bool = False


class NameIn(BaseModel):
    name: str = Field(min_length=1, max_length=300)


class NameIdIn(BaseModel):
    name_id: int


class OtherIn(BaseModel):
    """Another artist: one the Hub knows (`other_id`), or a name (one nobody has yet becomes an artist)."""

    other_id: int | None = None
    name: str | None = Field(default=None, max_length=300)


async def _artist(s: AsyncSession, artist_id: int) -> Artist:
    a = await s.get(Artist, artist_id)
    if a is None:
        raise HTTPException(404, "Исполнитель не найден")
    return a


async def _other(s: AsyncSession, body: OtherIn) -> Artist:
    if body.other_id:
        return await _artist(s, body.other_id)
    if body.name and body.name.strip():
        return await artists.resolve(s, body.name, "manual")
    raise HTTPException(400, "Не указан исполнитель")


async def _done(s: AsyncSession, user: User, a: Artist, *, rewrite: bool = False) -> dict[str, Any]:
    if rewrite:
        await enqueue(s, "artist_rewrite", {"artist_id": a.id, "user_id": user.id})
    out = await artists.card(s, a)
    await s.commit()
    if rewrite:
        notify()
    bus.publish(user.id, "library", {"kind": "changed", "album_id": None})
    return {**out, "rewriting": rewrite}


@router.get("/of", response_model=ArtistCardOut | None)
async def of(name: str | None = None, ref: str | None = None, user: User = Depends(current_user),
             s: AsyncSession = Depends(get_session, scope="function")):
    """The artist a page is of: by the catalog's own (`ref`) or by a name. None: neither was given."""
    a = await artists.of_ref(s, ref, name)
    if a is None:
        return None
    out = await artists.card(s, a)
    await s.commit()
    return out


@router.get("/find", response_model=list[ArtistPickOut])
async def find(q: str = Query(min_length=1), user: User = Depends(current_user),
               s: AsyncSession = Depends(get_session, scope="function")):
    return await artists.find(s, q)


@router.post("/{artist_id}/names", response_model=ArtistCardOut)
async def add_name(artist_id: int, body: NameIn, user: User = Depends(current_user),
                   s: AsyncSession = Depends(get_session, scope="function")):
    """One more spelling. 409 with the artist who has it already: the two may be joined (`/merge`)."""
    a = await _artist(s, artist_id)
    try:
        await artists.add_name(s, user.id, a, body.name)
    except artists.Taken as e:
        raise HTTPException(409, {"artist_id": e.artist_id, "name": e.name}) from e
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    return await _done(s, user, a)


@router.delete("/{artist_id}/names/{name_id}", response_model=ArtistCardOut)
async def drop_name(artist_id: int, name_id: int, user: User = Depends(current_user),
                    s: AsyncSession = Depends(get_session, scope="function")):
    a = await _artist(s, artist_id)
    try:
        await artists.drop_name(s, user.id, a, name_id)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    return await _done(s, user, a)


@router.post("/{artist_id}/main", response_model=ArtistCardOut)
async def set_main(artist_id: int, body: NameIdIn, user: User = Depends(current_user),
                   s: AsyncSession = Depends(get_session, scope="function")):
    """A spelling becomes the name: the library's tracks, albums and files are rewritten in it (a job)."""
    a = await _artist(s, artist_id)
    try:
        changed = await artists.set_main(s, user.id, a, body.name_id)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    return await _done(s, user, a, rewrite=changed)


@router.post("/{artist_id}/merge", response_model=ArtistCardOut)
async def merge(artist_id: int, body: OtherIn, user: User = Depends(current_user),
                s: AsyncSession = Depends(get_session, scope="function")):
    """The other artist is this one: their spellings come here, and the library is rewritten in this name."""
    a = await _artist(s, artist_id)
    other = await _other(s, body)
    if other.id == a.id:
        raise HTTPException(422, "Это тот же исполнитель")
    await artists.merge(s, user.id, a, other)
    return await _done(s, user, a, rewrite=True)


@router.post("/{artist_id}/projects", response_model=ArtistCardOut)
async def add_project(artist_id: int, body: OtherIn, user: User = Depends(current_user),
                      s: AsyncSession = Depends(get_session, scope="function")):
    a = await _artist(s, artist_id)
    try:
        await artists.link(s, user.id, a, await _other(s, body))
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    return await _done(s, user, a)


@router.delete("/{artist_id}/projects/{other_id}", response_model=ArtistCardOut)
async def drop_project(artist_id: int, other_id: int, user: User = Depends(current_user),
                       s: AsyncSession = Depends(get_session, scope="function")):
    a = await _artist(s, artist_id)
    await artists.link(s, user.id, a, await _artist(s, other_id), on=False)
    return await _done(s, user, a)


@router.post("/{artist_id}/apart", response_model=ArtistCardOut)
async def apart(artist_id: int, body: OtherIn, user: User = Depends(current_user),
                s: AsyncSession = Depends(get_session, scope="function")):
    """«Это другой»: not offered to be joined with this one again."""
    a = await _artist(s, artist_id)
    await artists.apart(s, a, await _other(s, body))
    return await _done(s, user, a)
