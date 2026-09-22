"""Native cancellation boundaries: synchronous callbacks and detached shadows.

Injected synchronous cancellations come from result() on an independently
cancelled application Future.
"""

import asyncio

import pytest
from formal.executor import Executor

from dialcache import DialCache, FallbackTimeoutError, Policy
from dialcache.protocol import Frame


@pytest.fixture
def executor():
    instance = Executor()
    try:
        yield instance
    finally:
        instance.close()


@pytest.fixture(params=[False, True], ids=["ordinary", "eager"])
def scheduled(request, executor):
    if request.param:
        if not hasattr(asyncio, "eager_task_factory"):
            pytest.skip("Eager task factories require Python 3.12+")
        executor.loop.set_task_factory(asyncio.eager_task_factory)
    return executor


def cancelled_result(executor):
    future = executor.future()
    future.cancel()
    return future.result


def call(cache, source, policy=None, **options):
    return cache.get_or_load(
        source,
        key="id",
        key_type="entity",
        use_case="callback-cancellation",
        default_config=policy,
        **options,
    )


def outcomes(events):
    return [event["outcome"] for event in events if event["event"] == "shadowValidation"]


@pytest.mark.parametrize("path", ["disabled", "source", "hit"])
@pytest.mark.parametrize("object_observer", [False, True])
def test_cancelled_metrics_preserve_disabled_source_and_hit(executor, path, object_observer):
    cancel = cancelled_result(executor)
    events, calls = [], []
    accepted = object()

    def source():
        calls.append(1)
        return accepted

    def observer(event):
        events.append(event)
        cancel()

    class Observer:
        observe = staticmethod(observer)

    cache = DialCache(clock=executor.clock)
    policy = Policy(ttl_sec={"local": 10})
    with cache.enable(path != "disabled"):
        if path == "hit":
            assert executor.finish(call(cache, source, policy)) is accepted
        cache.metrics = Observer() if object_observer else observer
        result = executor.task(call(cache, source, policy))
        executor.drain()
        assert result.result() is accepted
    assert result.cancelling() == 0
    assert calls == [1]
    assert events
    assert cache.get_coalescing_state()["process"]["active_leaders"] == 0


@pytest.mark.parametrize("enabled", [False, True])
def test_cancelled_metrics_preserve_original_source_error(executor, enabled):
    cancel = cancelled_result(executor)
    original = ValueError("original source failure")
    calls = []

    def source():
        calls.append(1)
        raise original

    cache = DialCache(clock=executor.clock, metrics=lambda event: cancel())
    with cache.enable(enabled):
        with pytest.raises(ValueError) as caught:
            executor.finish(call(cache, source, Policy(ttl_sec={"local": 10})))
    assert caught.value is original
    assert calls == [1]


@pytest.mark.parametrize("source_fails", [False, True])
def test_cancelled_warning_logger_preserves_source_outcome(executor, source_fails):
    cancel = cancelled_result(executor)
    warnings, calls = [], []
    config_error = RuntimeError("policy unavailable")
    source_error = ValueError("original source failure")
    accepted = object()

    class Logger:
        def warning(self, *args):
            warnings.append(args)
            cancel()

    def provider(key):
        raise config_error

    def source():
        calls.append(1)
        if source_fails:
            raise source_error
        return accepted

    cache = DialCache(clock=executor.clock, policy_provider=provider, logger=Logger())
    with cache.enable():
        if source_fails:
            with pytest.raises(ValueError) as caught:
                executor.finish(call(cache, source))
            assert caught.value is source_error
        else:
            assert executor.finish(call(cache, source)) is accepted
    assert calls == [1]
    assert len(warnings) == 1
    assert warnings[0][1] is config_error


@pytest.mark.parametrize("served", [False, True], ids=["dark", "served"])
def test_cancelled_supports_preserves_caller_and_starts_no_shadow(executor, served):
    cancel = cancelled_result(executor)
    events, supported, calls, reads = [], [], [], []

    class Observer:
        def observe(self, event):
            events.append(event)

        def supports(self, event):
            supported.append(event)
            return cancel()

    class Redis:
        def read(self, request, context):
            reads.append(request)
            return Frame(int(executor.clock.wall_ms()), '"cached"')

    def source():
        calls.append(1)
        return "source"

    cache = DialCache(clock=executor.clock, redis=Redis(), metrics=Observer())
    policy = Policy(ttl_sec={"remote": 10}, ramp={"remote": 100 if served else 0}, shadow={"ramp": 100})
    with cache.enable():
        assert executor.finish(call(cache, source, policy)) == ("cached" if served else "source")
    executor.drain()
    assert supported == ["shadowValidation"]
    assert calls == ([] if served else [1])
    assert len(reads) == int(served)
    assert outcomes(events) == []
    assert not asyncio.all_tasks(executor.loop)


@pytest.mark.parametrize("settlement", ["value", "error", "cancel"])
def test_cancelled_metrics_do_not_prevent_maintenance_dispatch_or_replace_result(executor, settlement):
    cancel = cancelled_result(executor)
    gate = executor.future()
    requests = []
    original = ValueError("original maintenance failure")

    class Redis:
        def invalidate(self, request):
            requests.append(request)
            return gate

    cache = DialCache(clock=executor.clock, redis=Redis(), metrics=lambda event: cancel())
    caller = executor.task(cache.invalidate_remote("entity", "id", 7))
    executor.drain()
    assert len(requests) == 1
    assert requests[0].future_buffer_ms == 7
    assert not caller.done()
    if settlement == "cancel":
        gate.cancel()
    elif settlement == "error":
        gate.set_exception(original)
    else:
        gate.set_result(None)
    executor.drain()
    assert caller.cancelling() == 0
    if settlement == "cancel":
        assert caller.cancelled()
    elif settlement == "error":
        assert caller.exception() is original
    else:
        assert caller.result() is None


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("observer_cancels", [False, True])
def test_observer_containment_preserves_real_caller_cancellation(executor, enabled, observer_cancels):
    cancel = cancelled_result(executor)
    gate = executor.future()
    started = []

    async def source():
        started.append(1)
        return await gate

    cache = DialCache(clock=executor.clock, metrics=(lambda event: cancel()) if observer_cancels else None)
    with cache.enable(enabled):
        caller = executor.task(call(cache, source, Policy(ttl_sec={"local": 10}, coalesce=False)))
        executor.drain()
        assert started == [1] and not caller.done()
        caller.cancel()
        executor.drain()
    assert caller.cancelled() and caller.cancelling() == 1
    if enabled:
        assert not gate.done()
        gate.set_result("late")
        executor.drain()
    else:
        assert gate.cancelled()


@pytest.mark.parametrize("observer_cancels", [False, True])
def test_observer_containment_preserves_real_maintenance_cancellation(executor, observer_cancels):
    cancel = cancelled_result(executor)
    gate = executor.future()
    requests = []

    class Redis:
        def invalidate(self, request):
            requests.append(request)
            return gate

    cache = DialCache(
        clock=executor.clock, redis=Redis(), metrics=(lambda event: cancel()) if observer_cancels else None
    )
    caller = executor.task(cache.invalidate_remote("entity", "id"))
    executor.drain()
    assert len(requests) == 1 and not caller.done()
    caller.cancel()
    executor.drain()
    assert caller.cancelled() and caller.cancelling() == 1
    assert gate.cancelled()


@pytest.mark.parametrize("source_fails", [False, True])
def test_cancelled_key_callback_preserves_source_and_skips_policy(executor, source_fails):
    cancel = cancelled_result(executor)
    events, calls, providers = [], [], []
    original = ValueError("original source failure")
    accepted = object()

    def source():
        calls.append(1)
        if source_fails:
            raise original
        return accepted

    cache = DialCache(clock=executor.clock, policy_provider=providers.append, metrics=events.append)
    with cache.enable():
        pending = call(cache, source, Policy(ttl_sec={"local": 10}), key_selector=cancel)
        if source_fails:
            with pytest.raises(ValueError) as caught:
                executor.finish(pending)
            assert caught.value is original
        else:
            assert executor.finish(pending) is accepted
    assert calls == [1]
    assert providers == []
    assert [e["error"] for e in events if e["event"] == "error"] == (
        ["key_construction", "fallback"] if source_fails else ["key_construction"]
    )


@pytest.mark.parametrize("coalesce", [False, True])
@pytest.mark.parametrize("phase", ["read", "put"])
def test_cancelled_local_callback_preserves_accepted_value_and_failed_layer(scheduled, coalesce, phase):
    executor = scheduled
    cancel = cancelled_result(executor)
    events, actions, sources = [], [], []
    accepted = object()

    class Local:
        def read(self, key):
            actions.append("read")
            if phase == "read":
                cancel()
            return False, None

        def put(self, key, value, ttl_sec):
            actions.append("put")
            assert value is accepted
            cancel()

    def source():
        sources.append(1)
        return accepted

    cache = DialCache(clock=executor.clock, local_store=Local(), metrics=events.append)
    with cache.enable():
        result = executor.task(call(cache, source, Policy(ttl_sec={"local": 10}, coalesce=coalesce)))
        executor.drain()
        assert result.result() is accepted
    assert result.cancelling() == 0
    assert sources == [1]
    assert actions == (["read"] if phase == "read" else ["read", "put"])
    assert [e["error"] for e in events if e["event"] == "error"] == [
        "cache_read" if phase == "read" else "cache_write"
    ]
    assert cache.get_coalescing_state()["process"]["active_leaders"] == 0


@pytest.mark.parametrize("coalesce", [False, True])
def test_cancelled_recovery_predicate_preserves_original_source_failure(scheduled, coalesce):
    executor = scheduled
    cancel = cancelled_result(executor)
    original = ValueError("original source failure")
    predicates, loads, writes = [], [], []

    class Redis:
        def read(self, request, context):
            return Frame(int(executor.clock.wall_ms()) - 2000, '"retained"')

        def write(self, request):
            writes.append(request)

    class Serializer:
        def load(self, payload):
            loads.append(payload)
            return "retained"

    def source():
        raise original

    def recovery(error):
        predicates.append(error)
        return cancel()

    cache = DialCache(
        clock=executor.clock,
        redis=Redis(),
        serializer=Serializer(),
        should_attempt_stale_recovery=recovery,
    )
    policy = Policy(ttl_sec={"remote": 1}, stale_on_error_max_age_sec=10, coalesce=coalesce)
    with cache.enable():
        with pytest.raises(ValueError) as caught:
            executor.finish(call(cache, source, policy))
    assert caught.value is original
    assert predicates == [original]
    assert loads == writes == []
    assert cache.get_coalescing_state()["process"]["active_leaders"] == 0


@pytest.mark.parametrize("coalesce", [False, True])
def test_abort_callback_cancellation_cannot_defeat_read_deadline(scheduled, coalesce):
    executor = scheduled
    cancel = cancelled_result(executor)
    raw = executor.future()
    contexts, aborts, sources, writes, events = [], [], [], [], []

    def first_abort():
        aborts.append("first")
        cancel()

    class Redis:
        def read(self, request, context):
            contexts.append(context)
            context.signal.add_callback(first_abort)
            context.signal.add_callback(lambda: aborts.append("second"))
            return raw

        def write(self, request):
            writes.append(request)

    def source():
        sources.append(1)
        return "source"

    cache = DialCache(clock=executor.clock, redis=Redis(), metrics=events.append, read_timeout_ms=7)
    with cache.enable():
        caller = executor.task(call(cache, source, Policy(ttl_sec={"remote": 10}, coalesce=coalesce)))
        executor.drain()
        executor.clock.advance(6)
        assert not caller.done() and not raw.done()
        executor.clock.advance(1)
        assert caller.result() == "source"
    assert caller.cancelling() == 0
    assert contexts[0].signal.aborted
    assert aborts == ["first", "second"]
    assert sources == [1] and writes == []
    assert not raw.done(), "Read timeout must leave the borrowed raw Future application owned"
    assert [e["error"] for e in events if e["event"] == "error"] == ["cache_read_timeout"]
    executor.clock.advance(70)
    assert not raw.done() and sources == [1] and writes == []


@pytest.mark.parametrize("result_kind", ["sync_result", "future", "coroutine"])
def test_cancelled_comparator_emits_one_terminal_outcome_after_served_hit(scheduled, result_kind):
    executor = scheduled
    cancelled = executor.future()
    cancelled.cancel()
    events, comparisons, reads, sources = [], [], [], []

    async def deferred_comparison():
        return await cancelled

    def compare(cached, source):
        comparisons.append((cached, source))
        if result_kind == "sync_result":
            return cancelled.result()
        return cancelled if result_kind == "future" else deferred_comparison()

    class Redis:
        def read(self, request, context):
            reads.append(request)
            return Frame(int(executor.clock.wall_ms()), '"cached"')

    def source():
        sources.append(1)
        return "source"

    cache = DialCache(clock=executor.clock, redis=Redis(), metrics=events.append)
    with cache.enable():
        caller = executor.task(
            call(
                cache,
                source,
                Policy(ttl_sec={"remote": 10}, shadow={"ramp": 100}),
                shadow_comparator=compare,
                fallback_timeout_ms=10,
            )
        )
        executor.drain()
        assert caller.result() == "cached"
    assert caller.cancelling() == 0
    assert comparisons == [("cached", "source")]
    assert sources == [1] and len(reads) == 1
    assert outcomes(events) == ["comparison_error"]
    executor.clock.advance(20)
    assert outcomes(events) == ["comparison_error"]
    assert not asyncio.all_tasks(executor.loop)


@pytest.mark.parametrize("served", [False, True], ids=["dark", "served"])
@pytest.mark.parametrize("cancel_at", ["before_start", "while_waiting", "deadline"])
def test_cancelled_shadow_source_has_one_phase_appropriate_outcome(scheduled, served, cancel_at):
    executor = scheduled
    source = executor.future()
    events, calls, reads, writes = [], [], [], []
    if cancel_at == "before_start":
        source.cancel()

    class Redis:
        def read(self, request, context):
            reads.append(request)
            return Frame(int(executor.clock.wall_ms()), '"cached"')

        def write(self, request):
            writes.append(request)

    def load():
        calls.append(1)
        return source

    cache = DialCache(clock=executor.clock, redis=Redis(), metrics=events.append)
    policy = Policy(ttl_sec={"remote": 10}, ramp={"remote": 100 if served else 0}, shadow={"ramp": 100})
    with cache.enable():
        caller = executor.task(call(cache, load, policy, fallback_timeout_ms=10))
        executor.drain()
        assert calls == [1]
        if cancel_at != "before_start":
            assert not source.done()
            if served:
                assert caller.result() == "cached"
            else:
                assert not caller.done()
            if cancel_at == "deadline":
                executor.clock.consume(10)
            source.cancel()
            executor.drain()
    assert source.cancelled()
    assert caller.cancelling() == 0
    if served:
        assert caller.result() == "cached"
    elif cancel_at == "deadline":
        assert isinstance(caller.exception(), FallbackTimeoutError)
    else:
        assert caller.cancelled(), "A dark shadow must not replace the caller's source cancellation"
    expected = "timeout" if cancel_at == "deadline" else "source_error"
    assert outcomes(events) == [expected]
    executor.clock.advance(20)
    assert outcomes(events) == [expected]
    assert calls == [1] and len(reads) == 1 and writes == []
    assert cache.get_coalescing_state()["process"]["active_leaders"] == 0
    assert not asyncio.all_tasks(executor.loop)
