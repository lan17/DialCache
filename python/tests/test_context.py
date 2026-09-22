import asyncio
from contextvars import copy_context

import pytest

from dialcache.context import DialCacheContext


def test_nested_enable_disable_preserves_holder_without_clearing_values():
    context = DialCacheContext()
    assert not context.is_enabled()
    assert context.request_cache() is None
    with context.enable():
        outer = context.request_cache()
        outer.set("key", None)
        with context.disable():
            assert not context.is_enabled()
            assert context.request_cache() is None
            with context.enable():
                assert context.is_enabled()
                assert context.request_cache() is outer
                assert outer.read("key") == (True, None)
        assert outer.read("key") == (True, None)
    assert outer.closed
    assert outer.read("key") == (False, None)
    outer.set("late", 1)
    assert outer.read("late") == (False, None)


def test_instances_are_independent_and_outer_exception_closes_holder():
    first, second = DialCacheContext(), DialCacheContext()
    with pytest.raises(ValueError):
        with first.enable():
            memo = first.request_cache()
            memo.in_flight["key"] = object()
            assert first.is_enabled()
            assert not second.is_enabled()
            raise ValueError("source failure")
    assert memo.closed
    assert not memo.in_flight
    assert not first.is_enabled()


async def test_closed_context_disables_detached_calls_and_reenable_owns_new_holder():
    context = DialCacheContext()
    release = asyncio.Event()

    async def detached():
        await release.wait()
        assert not context.is_enabled()
        assert context.request_cache() is None
        with context.enable():
            assert context.is_enabled()
            assert context.request_cache() is not original

    async with context.enable():
        original = context.request_cache()
        task = asyncio.create_task(detached())
        copied = copy_context()
    assert copied.run(context.is_enabled) is False
    release.set()
    await task


async def test_independent_sibling_scopes_never_share_memo():
    context = DialCacheContext()
    release = asyncio.Event()
    memos = []

    async def sibling():
        async with context.enable():
            memos.append(context.request_cache())
            await release.wait()

    first, second = asyncio.create_task(sibling()), asyncio.create_task(sibling())
    await asyncio.sleep(0)
    assert len(memos) == 2
    assert memos[0] is not memos[1]
    release.set()
    await asyncio.gather(first, second)
    assert all(memo.closed for memo in memos)
