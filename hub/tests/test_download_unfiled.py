"""A download whose filing failed is not taken for a filed one: it is downloaded again."""

import pytest
from sqlalchemy import select

from app import db
from app.jobs.downloads import filed, recover_unfiled
from app.matching.normalize import fingerprint
from app.models import DownloadBatch, DownloadItem, Job, User
from app.security import encrypt
from tests.support import filed_track


@pytest.fixture
async def env(hub_env):
    db.init_engine()
    try:
        async with db.session_scope() as s:
            user = User(nd_username="qa", nd_password_enc=encrypt("qa-password"))
            s.add(user)
            await s.flush()
            batch = DownloadBatch(user_id=user.id, origin="hub", title="t")
            s.add(batch)
            have = filed_track(path="a.mp3", artist="A", title="a", fingerprint=fingerprint("A", "a"))
            s.add(have)
            await s.flush()
            yield_ = (user.id, batch.id, have.id)
        yield yield_
    finally:
        await db.dispose()


async def item(user_id, batch_id, **fields):
    async with db.session_scope() as s:
        it = DownloadItem(batch_id=batch_id, user_id=user_id, query_json={"query": {"artist": "A", "title": "a"}}, **fields)
        s.add(it)
        await s.flush()
        return it.id


async def test_an_item_left_importing_with_no_file_goes_back_to_the_queue(env):
    user_id, batch_id, have = env
    lost = await item(user_id, batch_id, status="importing")
    waits = await item(user_id, batch_id, status="importing", track_id=have)  # its file is there: Navidrome is waited for
    async with db.session_scope() as s:
        assert not await filed(s, await s.get(DownloadItem, lost))
        assert await filed(s, await s.get(DownloadItem, waits))
    assert await recover_unfiled() == 1
    assert await recover_unfiled() == 0  # its job is waiting already
    async with db.session_scope() as s:
        assert (await s.get(DownloadItem, lost)).status == "queued"
        assert (await s.get(DownloadItem, waits)).status == "importing"
        jobs = list((await s.execute(select(Job).where(Job.kind == "download_item"))).scalars())
        assert [j.payload_json for j in jobs] == [{"item_id": lost}]
