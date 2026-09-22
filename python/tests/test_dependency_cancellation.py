"""Independently cancelled extensions fail open; callers and sources retain cancellation."""

from __future__ import annotations

import asyncio
import inspect
import json

import pytest
from formal.executor import Executor

from dialcache import DialCache, Policy
from dialcache.protocol import Frame, Miss


@pytest.fixture(params=[False, True], ids=["ordinary", "eager"])
def executor(request):
    instance = Executor()
    if request.param:
        if not hasattr(asyncio, "eager_task_factory"):
            instance.close()
            pytest.skip("Eager task factories require Python 3.12+")
        instance.loop.set_task_factory(asyncio.eager_task_factory)
    try:
        yield instance
    finally:
        instance.close()


def cancel_dependency(executor, kind):
    if kind == "raised":
        raise asyncio.CancelledError("extension cancelled itself")
    future = executor.future()
    future.cancel()
    return future


class BoundaryProbe:
    """Application dependencies with visible source and publication effects."""

    def __init__(self, executor, boundary, dependency, *, coalesce):
        self.executor, self.boundary, self.dependency = executor, boundary, dependency
        self.source_value, self.cached_value = {"value": "source"}, {"value": "cached"}
        self.entered, self.sources, self.reads, self.dumps, self.writes = [], [], [], [], []
        self.completed_writes, self.events = [], []
        self.policy_config = Policy(ttl_sec={"local": 10, "remote": 10}, coalesce=coalesce)
        self.cache = DialCache(
            clock=executor.clock,
            redis=self,
            serializer=self,
            policy_provider=self.policy,
            metrics=self.events.append,
            compression=False,
        )

    def at(self, boundary, normal):
        if boundary == self.boundary:
            self.entered.append(boundary)
            return self.dependency()
        return normal

    def policy(self, key):
        return self.at("policy", None)

    def read(self, request, context):
        self.reads.append(request)
        normal = (
            Frame(int(self.executor.clock.wall_ms()), json.dumps(self.cached_value))
            if self.boundary == "load"
            else Miss("value_absent")
        )
        return self.at("read", normal)

    def load(self, payload):
        return self.at("load", json.loads(payload))

    def dump(self, value):
        self.dumps.append(value)
        return self.at("dump", json.dumps(value))

    def write(self, request):
        self.writes.append(request)
        result = self.at("write", None)
        if inspect.isawaitable(result):

            async def complete():
                await result
                self.completed_writes.append(request)

            return complete()
        self.completed_writes.append(request)
        return result

    def source(self):
        self.sources.append(self.source_value)
        return self.source_value

    def call(self):
        return self.cache.get_or_load(
            self.source,
            key="id",
            key_type="entity",
            use_case="dependency-cancellation",
            default_config=self.policy_config,
        )


@pytest.mark.parametrize("coalesce", [False, True], ids=["unshared", "shared"])
@pytest.mark.parametrize("kind", ["future", "raised"])
@pytest.mark.parametrize("boundary", ["policy", "read", "load", "dump", "write"])
def test_independent_dependency_cancellation_preserves_source_and_publication(
    executor, boundary, kind, coalesce
):
    probe = BoundaryProbe(executor, boundary, lambda: cancel_dependency(executor, kind), coalesce=coalesce)
    with probe.cache.enable():
        caller = executor.task(probe.call())
        executor.drain()
        assert caller.cancelling() == 0
        assert caller.result() is probe.source_value
        assert len(probe.sources) == 1
        assert len(probe.reads) == (boundary != "policy")
        assert len(probe.dumps) == (boundary in ("load", "dump", "write"))
        assert len(probe.writes) == (boundary in ("load", "write"))
        assert len(probe.completed_writes) == (boundary == "load")
        assert [e["error"] for e in probe.events if e["event"] == "error"] == [
            {
                "policy": "config_resolution",
                "read": "cache_read",
                "load": "serialization_load",
                "dump": "serialization_dump",
                "write": "cache_write",
            }[boundary]
        ]
        # Failed policy resolution disables caching. Later phases still permit
        # this untracked value to populate the healthy local layer.
        assert executor.finish(probe.call()) is probe.source_value
        assert len(probe.sources) == (2 if boundary == "policy" else 1)
        assert probe.entered == [boundary] * (2 if boundary == "policy" else 1)
    assert probe.cache.get_coalescing_state()["process"]["active_leaders"] == 0
    assert not asyncio.all_tasks(executor.loop)


@pytest.mark.parametrize("boundary", ["policy", "read", "load", "dump", "write"])
def test_real_unshared_caller_cancellation_during_dependency_propagates(executor, boundary):
    gate = executor.future()
    probe = BoundaryProbe(executor, boundary, lambda: gate, coalesce=False)
    with probe.cache.enable():
        caller = executor.task(probe.call())
        executor.drain()
        assert probe.entered == [boundary]
        assert not caller.done()
        caller.cancel()
        executor.drain()
        assert caller.cancelled()
        assert caller.cancelling() == 1
        assert len(probe.sources) == (boundary in ("dump", "write"))
        assert probe.completed_writes == []
        if boundary == "read":
            # The raw adapter operation retains its established independent
            # lifetime, but its late result cannot publish for this caller.
            assert not gate.cancelled()
            gate.set_result(Miss("value_absent"))
            executor.drain()
        else:
            assert gate.cancelled()
        assert probe.completed_writes == []
        sources_before_retry = len(probe.sources)
        probe.boundary = None
        assert executor.finish(probe.call()) is probe.source_value
        assert len(probe.sources) == sources_before_retry + 1
        assert len(probe.completed_writes) == 1
    assert not asyncio.all_tasks(executor.loop)


@pytest.mark.parametrize("coalesce", [False, True], ids=["unshared", "shared"])
@pytest.mark.parametrize("enabled", [False, True], ids=["disabled", "enabled"])
@pytest.mark.parametrize("kind", ["future", "raised", "pending"])
def test_source_cancellation_propagates_and_never_publishes(executor, coalesce, enabled, kind):
    probe = BoundaryProbe(executor, None, lambda: None, coalesce=coalesce)
    gate = executor.future()

    def source():
        probe.sources.append(probe.source_value)
        return gate if kind == "pending" else cancel_dependency(executor, kind)

    probe.source = source
    with probe.cache.enable(enabled):
        caller = executor.task(probe.call())
        executor.drain()
        if kind == "pending":
            assert not caller.done()
            gate.cancel()
            executor.drain()
        assert caller.cancelling() == 0
        with pytest.raises(asyncio.CancelledError):
            caller.result()
        assert probe.sources == [probe.source_value]
        assert probe.dumps == probe.writes == []
        assert len(probe.reads) == enabled
        assert probe.cache.get_coalescing_state()["process"]["active_leaders"] == 0
        probe.source = lambda: probe.sources.append(probe.source_value) or probe.source_value
        assert executor.finish(probe.call()) is probe.source_value
        assert len(probe.sources) == 2
        assert len(probe.completed_writes) == enabled
    assert not asyncio.all_tasks(executor.loop)


@pytest.mark.parametrize("cancel_leader", [False, True], ids=["cancel-follower", "cancel-first"])
@pytest.mark.parametrize("boundary", ["read", "load", "dump", "write"])
def test_cancelling_shared_waiter_preserves_dependency_for_survivor(executor, boundary, cancel_leader):
    gate = executor.future()
    probe = BoundaryProbe(executor, boundary, lambda: gate, coalesce=True)
    with probe.cache.enable():
        first = executor.task(probe.call())
        executor.drain()
    # Distinct request contexts still join the same process work.
    with probe.cache.enable():
        second = executor.task(probe.call())
        executor.drain()
        assert probe.entered == [boundary]
        assert probe.cache.get_coalescing_state()["process"]["active_followers"] == 1
        cancelled, survivor = (first, second) if cancel_leader else (second, first)
        cancelled.cancel()
        executor.drain()
        assert cancelled.cancelled()
        assert not survivor.done()
        assert not gate.cancelled()
        # The documented follower count remains until leader settlement.
        assert probe.cache.get_coalescing_state()["process"]["active_followers"] == 1
        gate.set_result(
            {
                "read": Miss("value_absent"),
                "load": probe.cached_value,
                "dump": json.dumps(probe.source_value),
                "write": None,
            }[boundary]
        )
        executor.drain()
        expected = probe.cached_value if boundary == "load" else probe.source_value
        assert survivor.result() is expected
        assert executor.finish(probe.call()) is expected
    assert len(probe.sources) == (boundary != "load")
    assert len(probe.completed_writes) == (boundary != "load")
    assert probe.cache.get_coalescing_state()["process"]["active_leaders"] == 0
    assert not asyncio.all_tasks(executor.loop)


@pytest.mark.parametrize("boundary", ["read", "load", "dump", "write"])
def test_cancelled_pending_dependency_fails_open_for_both_shared_waiters(executor, boundary):
    gate = executor.future()
    probe = BoundaryProbe(executor, boundary, lambda: gate, coalesce=True)
    with probe.cache.enable():
        first = executor.task(probe.call())
        executor.drain()
        second = executor.task(probe.call())
        executor.drain()
        assert probe.entered == [boundary]
        assert probe.cache.get_coalescing_state()["process"]["active_followers"] == 1
        gate.cancel()
        executor.drain()
        assert first.cancelling() == second.cancelling() == 0
        assert first.result() is second.result() is probe.source_value
        assert executor.finish(probe.call()) is probe.source_value
    assert len(probe.sources) == 1
    assert len(probe.writes) == (boundary in ("load", "write"))
    assert len(probe.completed_writes) == (boundary == "load")
    assert probe.cache.get_coalescing_state()["process"]["active_leaders"] == 0
    assert not asyncio.all_tasks(executor.loop)


def retained_recovery(executor, decode, *, coalesce):
    failure = ValueError("original source failure")
    sources, decodes, writes, events = [], [], [], []

    class Redis:
        def read(self, request, context):
            return Frame(int(executor.clock.wall_ms()) - 2000, '"stale"')

        def write(self, request):
            writes.append(request)

    class Serializer:
        def load(self, payload):
            decodes.append(payload)
            return decode()

    def source():
        sources.append(failure)
        raise failure

    cache = DialCache(
        clock=executor.clock,
        redis=Redis(),
        serializer=Serializer(),
        metrics=events.append,
        should_attempt_stale_recovery=lambda error: error is failure,
    )
    with cache.enable():
        caller = executor.task(
            cache.get_or_load(
                source,
                key="id",
                key_type="entity",
                use_case="retained-decode",
                default_config=Policy(
                    ttl_sec={"local": 1, "remote": 1},
                    stale_on_error_max_age_sec=10,
                    coalesce=coalesce,
                ),
            )
        )
        executor.drain()
    assert sources == [failure]
    assert decodes == ['"stale"']
    return caller, cache, failure, writes, events


@pytest.mark.parametrize("coalesce", [False, True], ids=["unshared", "shared"])
@pytest.mark.parametrize("kind", ["future", "raised", "pending"])
def test_independently_cancelled_retained_decode_preserves_original_error(executor, coalesce, kind):
    gate = executor.future()
    caller, cache, failure, writes, events = retained_recovery(
        executor, lambda: gate if kind == "pending" else cancel_dependency(executor, kind), coalesce=coalesce
    )
    if kind == "pending":
        assert not caller.done()
        gate.cancel()
        executor.drain()
    assert caller.cancelling() == 0
    with pytest.raises(ValueError) as caught:
        caller.result()
    assert caught.value is failure
    assert writes == []
    assert [e["outcome"] for e in events if e["event"] == "staleRecovery"] == ["deserialization_error"]
    assert cache.get_coalescing_state()["process"]["active_leaders"] == 0
    assert not asyncio.all_tasks(executor.loop)


def test_real_caller_cancellation_during_retained_decode_is_not_replaced_by_source_error(executor):
    gate = executor.future()
    caller, cache, failure, writes, events = retained_recovery(executor, lambda: gate, coalesce=False)
    assert not caller.done()
    caller.cancel()
    executor.drain()
    with pytest.raises(asyncio.CancelledError):
        caller.result()
    assert caller.cancelling() == 1
    assert gate.cancelled()
    assert writes == []
    assert not [e for e in events if e["event"] == "staleRecovery"]
    assert cache.get_coalescing_state()["process"]["active_leaders"] == 0
    assert not asyncio.all_tasks(executor.loop)
