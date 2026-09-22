"""Independent native scheduling boundaries from the Python port review."""

from __future__ import annotations

import asyncio

import pytest

from dialcache import DialCache, Policy


@pytest.mark.skipif(
    not hasattr(asyncio, "eager_task_factory"), reason="Eager task factories require Python 3.12+"
)
@pytest.mark.parametrize(
    "policy",
    [
        Policy(ttl_sec={"local": 60}),
        Policy(request_local=True),
        Policy(ttl_sec={"local": 60}, request_local=True),
    ],
)
async def test_cached_hit_is_safe_under_native_eager_task_factory(policy):
    loop = asyncio.get_running_loop()
    previous = loop.get_task_factory()
    loop.set_task_factory(asyncio.eager_task_factory)
    calls = []
    cache = DialCache()

    def source():
        calls.append(1)
        return "cached"

    async def get():
        return await cache.get_or_load(
            source, key="id", key_type="entity", use_case="eager-hit", default_config=policy
        )

    try:
        with cache.enable():
            assert await get() == "cached"
            assert await get() == "cached"
            assert calls == [1]
            assert cache.get_coalescing_state()["process"]["active_leaders"] == 0
    finally:
        loop.set_task_factory(previous)


@pytest.mark.skipif(
    not hasattr(asyncio, "eager_task_factory"), reason="Eager task factories require Python 3.12+"
)
@pytest.mark.parametrize("cancel_leader", [True, False])
@pytest.mark.parametrize("policy", [Policy(ttl_sec={"local": 60}), Policy(request_local=True)])
async def test_eager_shared_source_survives_caller_cancellation(cancel_leader, policy):
    loop = asyncio.get_running_loop()
    previous = loop.get_task_factory()
    loop.set_task_factory(asyncio.eager_task_factory)
    gate = loop.create_future()
    started = []
    cache = DialCache()

    async def source():
        started.append(1)
        return await gate

    async def get():
        return await cache.get_or_load(
            source, key="id", key_type="entity", use_case="eager-cancel", default_config=policy
        )

    try:
        with cache.enable():
            leader = asyncio.create_task(get())
            follower = asyncio.create_task(get())
            assert started == [1]
            cancelled, survivor = (leader, follower) if cancel_leader else (follower, leader)
            cancelled.cancel()
            with pytest.raises(asyncio.CancelledError):
                await cancelled
            assert not gate.cancelled()
            gate.set_result("shared")
            assert await survivor == "shared"
            assert await get() == "shared"
            assert started == [1]
            assert cache.get_coalescing_state()["process"]["active_leaders"] == 0
    finally:
        loop.set_task_factory(previous)
