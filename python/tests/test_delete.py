"""Exact-key maintenance API, validation and adapter failure boundaries."""

import asyncio
from contextlib import nullcontext
from contextvars import Context
from types import SimpleNamespace

import pytest
from formal.driver import FakeRedis
from formal.executor import Executor

from dialcache import DialCache, Key, Policy, RemoteDeleteUnsupportedError, UseCaseNameIsReservedError
from dialcache.key import normalize_args
from dialcache.local import MISSING


@pytest.fixture
def executor():
    value = Executor()
    try:
        yield value
    finally:
        value.close()


@pytest.mark.parametrize("tracked", [False, True])
@pytest.mark.parametrize("disabled", [False, True])
def test_delete_exact_identity_live_memo_and_flights(executor, tracked, disabled):
    redis = FakeRedis(executor.clock)
    events, policy_calls = [], []
    cache = DialCache(redis=redis, namespace="deletion", clock=executor.clock, metrics=events.append,
                      policy_provider=lambda key: policy_calls.append(key))
    identity = dict(key={"id": "42", "args": {"locale": "en"}}, key_type="user", use_case="Get",
                    track_for_invalidation=tracked)
    key = Key("deletion", "user", "42", "Get", normalize_args({"locale": "en"}), tracked)
    sibling = Key("deletion", "user", "42", "Get", normalize_args({"locale": "fr"}), tracked)
    cache._local.put(key.logical, 1, 60)
    cache._local.put(sibling.logical, 2, 60)
    redis.seed(key.value_key, b"old")
    redis.seed(sibling.value_key, b"sibling")
    if tracked:
        redis.seed(key.watermark_key, b"23")
    with cache.enable():
        memo = cache._context.request_cache()
        memo.set(key.logical, 1)
        memo.set(sibling.logical, 2)
        flight = object()
        memo.in_flight[key.logical] = flight
        cache._flights[key.logical] = flight
        with cache.disable() if disabled else nullcontext():
            executor.finish(cache.delete(**identity))
        assert memo.read(key.logical) == (False, None)
        assert memo.read(sibling.logical) == (True, 2)
        assert memo.in_flight[key.logical] is cache._flights[key.logical] is flight
        executor.finish(cache.delete(**identity))  # Missing is success.
    assert cache._local.get(key.logical) is MISSING
    assert cache._local.get(sibling.logical) == 2
    assert redis.raw(key.value_key) is None
    assert redis.raw(sibling.value_key) == b"sibling"
    if tracked:
        assert redis.raw(key.watermark_key) == b"23"
    assert policy_calls == []
    assert events == [dict(event="deletion", cacheNamespace="deletion", keyType="user", useCase="Get",
                           layer="remote")] * 2


@pytest.mark.parametrize("failure", [False, True])
def test_remote_first_and_failure_preserves_local(executor, failure):
    events, warnings = [], []
    problem = RuntimeError("ambiguous remote failure")
    key = Key("urn", "id", "42", "Get")
    calls = []

    class Logger:
        def warning(self, *args):
            warnings.append(args)
            raise RuntimeError("logger failure")

    class Remote:
        async def delete(self, request):
            calls.append(request.value_key)
            assert cache._local.get(key.logical) == 1
            assert cache._context.request_cache().read(key.logical) == (True, 1)
            await asyncio.sleep(0)
            if failure:
                raise problem

    cache = DialCache(redis=Remote(), clock=executor.clock, metrics=events.append, logger=Logger())
    cache._local.put(key.logical, 1, 60)
    with cache.enable():
        memo = cache._context.request_cache()
        memo.set(key.logical, 1)
        if failure:
            with pytest.raises(RuntimeError) as raised:
                executor.finish(cache.delete(key="42", key_type="id", use_case="Get"))
            assert raised.value is problem
            assert cache._local.get(key.logical) == 1
            assert memo.read(key.logical) == (True, 1)
            assert events[-1]["event"] == "error" and events[-1]["error"] == "deletion"
            assert events[-1]["layer"] == "remote" and len(warnings) == 1
        else:
            executor.finish(cache.delete(key="42", key_type="id", use_case="Get"))
            assert cache._local.get(key.logical) is MISSING
            assert memo.read(key.logical) == (False, None)
    assert calls == [key.value_key]
    assert events[0]["event"] == "deletion"


@pytest.mark.parametrize("remote", [object(), SimpleNamespace(delete=3)])
def test_validation_and_capability_precede_metrics_and_mutation(executor, remote):
    events = []
    cache = DialCache(redis=remote, metrics=events.append, clock=executor.clock)
    key = Key("urn", "id", "42", "Get")
    cache._local.put(key.logical, 1, 60)
    with cache.enable():
        memo = cache._context.request_cache()
        memo.set(key.logical, 1)
        for options, error in [
            (dict(key="42", key_type="id", use_case="watermark"), UseCaseNameIsReservedError),
            (dict(key="{", key_type="id", use_case="Get", track_for_invalidation=True), ValueError),
            (dict(key={"args": {"locale": "en"}}, key_type="id", use_case="Get"), TypeError),
            (dict(key="42", key_type="id", use_case="Get"), RemoteDeleteUnsupportedError),
        ]:
            with pytest.raises(error):
                executor.finish(cache.delete(**options))
            assert cache._local.get(key.logical) == 1
            assert memo.read(key.logical) == (True, 1)
    assert events == []


@pytest.mark.parametrize("overrides", [
    {},
    {"key_type": "other"},
    {"use_case": "Other"},
    {"track_for_invalidation": False},
], ids=["matching", "key-type", "use-case", "tracking"])
def test_delete_rejects_prebuilt_key_before_any_effects(executor, overrides):
    calls, events = [], []
    remote = SimpleNamespace(delete=lambda request: calls.append(request.value_key))
    cache = DialCache(redis=remote, metrics=events.append, clock=executor.clock)
    key = Key("urn", "id", "42", "Get", tracked=True)
    options = dict(key_type="id", use_case="Get", track_for_invalidation=True)
    options.update(overrides)
    cache._local.put(key.logical, 1, 60)
    with cache.enable():
        memo = cache._context.request_cache()
        memo.set(key.logical, 1)
        with pytest.raises(TypeError, match="Cache key scalar"):
            executor.finish(cache.delete(key=key, **options))
        assert cache._local.get(key.logical) == 1
        assert memo.read(key.logical) == (True, 1)
    assert calls == []
    assert events == []


@pytest.mark.parametrize("capacity", [0, 2])
def test_local_only_outside_scope_and_memo_not_created(executor, capacity):
    events = []
    cache = DialCache(clock=executor.clock, local_max_size=capacity, metrics=events.append)
    key = Key("urn", "id", "42", "Get")
    cache._local.put(key.logical, 1, 60)
    outside = Context()
    with cache.enable():
        holder = cache._context._live_holder()
        executor.finish(cache.delete(key="42", key_type="id", use_case="Get"))
        assert holder.memo is None
        memo = cache._context.request_cache()
        memo.set(key.logical, 1)
        executor.finish(cache.delete(key="42", key_type="id", use_case="Get"), outside)
        assert memo.read(key.logical) == (True, 1)
        with cache.disable():
            executor.finish(cache.delete(key="42", key_type="id", use_case="Get"))
        assert memo.read(key.logical) == (False, None)
    assert cache._local.get(key.logical) is MISSING
    assert all(event["layer"] == "local" for event in events)


def test_late_load_can_publish_after_delete(executor):
    cache = DialCache(clock=executor.clock)
    gate = executor.future()
    kwargs = dict(key="42", key_type="id", use_case="Get", default_config=Policy.enabled(60))
    with cache.enable():
        pending = executor.task(cache.get_or_load(lambda: gate, **kwargs))
        executor.drain()
        executor.finish(cache.delete(key="42", key_type="id", use_case="Get"))
        gate.set_result(7)
        executor.drain()
        assert pending.result() == 7
        assert executor.finish(cache.get_or_load(lambda: 9, **kwargs)) == 7
