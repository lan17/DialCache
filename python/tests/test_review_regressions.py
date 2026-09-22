"""Public boundary regressions from the independent Python PR review."""

import asyncio

import pytest
from formal.executor import Executor

from dialcache import DialCache, FallbackTimeoutError, Policy
from dialcache.protocol import Frame, Miss


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


@pytest.mark.parametrize("remote", [False, True], ids=["source", "read"])
def test_callback_budget_excludes_queued_work(executor, remote):
    events = []
    invoked = []

    class Redis:
        def read(self, request, context):
            invoked.append(("read", executor.clock.monotonic_ms()))
            return Frame(int(executor.clock.wall_ms()), '"cached"')

    def provider(key):
        executor.loop.call_soon(executor.clock.consume, 20)

    def source():
        invoked.append(("source", executor.clock.monotonic_ms()))
        return "source"

    cache = DialCache(
        clock=executor.clock,
        redis=Redis() if remote else None,
        policy_provider=provider,
        metrics=events.append,
    )
    with cache.enable():
        value = executor.finish(
            cache.get_or_load(
                source,
                key="a",
                key_type="entity",
                use_case="origin",
                fallback_timeout_ms=10,
                default_config=Policy(ttl_sec={"remote": 10}, remote_read_timeout_ms=10, coalesce=False),
            )
        )
    assert value == ("cached" if remote else "source")
    assert invoked == [("read" if remote else "source", 20)]
    assert not [e for e in events if e["event"] == "error"]
    if not remote:
        assert [e["seconds"] for e in events if e["event"] == "fallback"] == [0]


@pytest.mark.parametrize("kind", ["success", "failure", "before_await"])
@pytest.mark.parametrize("remote", [False, True], ids=["source", "read"])
def test_callback_budget_counts_synchronous_work(scheduled, kind, remote):
    executor = scheduled
    events, signals, writes = [], [], []

    def work():
        executor.clock.consume(10)
        if kind == "failure":
            raise ValueError("raw callback failure")
        return Frame(int(executor.clock.wall_ms()), '"late"') if remote else "late"

    async def asynchronous_work():
        value = work()
        await asyncio.sleep(0)
        return value

    class Redis:
        def read(self, request, context):
            context.signal.add_callback(lambda: signals.append("abort"))
            return asynchronous_work() if kind == "before_await" else work()

        def write(self, request):
            writes.append(request)

    cache = DialCache(clock=executor.clock, redis=Redis() if remote else None, metrics=events.append)
    with cache.enable():
        call = cache.get_or_load(
            (lambda: "source") if remote else (asynchronous_work if kind == "before_await" else work),
            key="a",
            key_type="entity",
            use_case="budget",
            fallback_timeout_ms=10,
            default_config=Policy(ttl_sec={"remote": 10}, remote_read_timeout_ms=10),
        )
        if remote:
            assert executor.finish(call) == "source"
            assert signals == ["abort"]
            assert writes == []
            assert [e["error"] for e in events if e["event"] == "error"] == ["cache_read_timeout"]
        else:
            with pytest.raises(FallbackTimeoutError):
                executor.finish(call)


@pytest.mark.parametrize("ramp", [10**1000, -(10**1000)])
@pytest.mark.parametrize("dark", [False, True])
def test_invalid_shadow_ramp_preserves_normal_result(executor, ramp, dark):
    events, writes = [], []

    class Redis:
        def read(self, request, context):
            return Frame(int(executor.clock.wall_ms()), '"cached"')

        def write(self, request):
            writes.append(request)

    cache = DialCache(
        clock=executor.clock,
        redis=Redis(),
        metrics=events.append,
        policy_provider=lambda key: {"shadow": {"ramp": ramp}},
    )
    with cache.enable():
        result = executor.finish(
            cache.get_or_load(
                lambda: "source",
                key="a",
                key_type="entity",
                use_case="invalid-shadow",
                default_config=Policy(ttl_sec={"remote": 10}, ramp={"remote": 0 if dark else 100}),
            )
        )
    assert result == ("source" if dark else "cached")
    assert [e["error"] for e in events if e["event"] == "error"] == ["config_resolution"]
    assert not [e for e in events if e["event"] == "shadowValidation"]
    assert writes == []


@pytest.mark.parametrize("policy", [Policy(request_local=True), Policy(ttl_sec={"local": 10})])
async def test_explicit_self_adapter_separates_repository_instances(policy):
    calls, adapters = [], []
    cache = DialCache()

    def adapt_self(repo):
        adapters.append(repo.tenant)
        return repo.tenant

    class Repository:
        def __init__(self, tenant):
            self.tenant = tenant

        @cache.cached(key_type="user", id_arg="uid", arg_adapters={"self": adapt_self}, default_config=policy)
        async def get(self, uid):
            calls.append(self.tenant)
            return f"{self.tenant}:{uid}"

    a, b = Repository("tenant-a"), Repository("tenant-b")
    assert await a.get("42") == "tenant-a:42"
    assert adapters == []
    calls.clear()
    with cache.enable():
        assert await a.get("42") == "tenant-a:42"
        assert await b.get("42") == "tenant-b:42"
        assert await a.get("42") == "tenant-a:42"
    assert calls == ["tenant-a", "tenant-b"]
    assert adapters == ["tenant-a", "tenant-b", "tenant-a"]


@pytest.mark.parametrize("ignore", [False, True])
async def test_default_self_omission_and_explicit_ignore_are_preserved(ignore):
    cache = DialCache()
    calls = []

    def forbidden(repo):
        raise AssertionError("An explicitly ignored self must not be adapted")

    class Repository:
        @cache.cached(
            key_type="user",
            id_arg="uid",
            arg_adapters={"self": forbidden} if ignore else None,
            ignore_args=["self"] if ignore else (),
            default_config=Policy(request_local=True),
        )
        async def get(self, uid):
            calls.append(self)
            return uid

    with cache.enable():
        assert await Repository().get("42") == await Repository().get("42") == "42"
    assert len(calls) == 1


@pytest.mark.parametrize("enabled", [False, True])
@pytest.mark.parametrize("object_observer", [False, True])
def test_async_observer_is_not_started_or_retained(executor, enabled, object_observer):
    started = []
    gate = executor.future()

    async def observer(event):
        started.append(event)
        await gate

    class Observer:
        observe = staticmethod(observer)

    cache = DialCache(clock=executor.clock, metrics=Observer() if object_observer else observer)
    with cache.enable(enabled):
        for _ in range(20):
            assert (
                executor.finish(
                    cache.get_or_load(
                        lambda: 1,
                        key="a",
                        key_type="entity",
                        use_case="observer",
                        default_config=Policy(request_local=True),
                    )
                )
                == 1
            )
    executor.drain()
    assert started == []
    assert not asyncio.all_tasks(executor.loop)


@pytest.mark.parametrize("layers", ["none", "request", "process", "nested"])
@pytest.mark.parametrize("mode", ["fill", "compare", "served"])
def test_shadow_synchronous_phases_follow_caller_continuation(scheduled, layers, mode):
    executor = scheduled
    events = []
    gate = executor.future()

    class Redis:
        def read(self, request, context):
            events.append("read")
            return Miss("value_absent") if mode == "fill" else Frame(int(executor.clock.wall_ms()), "1")

        def write(self, request):
            events.append("write")

    class Serializer:
        def load(self, payload):
            events.append("decode")
            return 1

        def dump(self, value):
            events.append("dump")
            return "1"

    async def source():
        if mode != "served":
            await gate
        events.append("source")
        return 1

    def compare(a, b):
        events.append("compare")
        return a == b

    policy = Policy(
        request_local=layers in ("request", "nested"),
        ttl_sec={"remote": 10, **({"local": 10} if layers in ("process", "nested") else {})},
        ramp={"remote": 100 if mode == "served" else 0},
        shadow={"ramp": 100},
    )
    cache = DialCache(clock=executor.clock, redis=Redis(), serializer=Serializer(), metrics=lambda e: None)

    async def caller():
        result = await cache.get_or_load(
            source,
            key="a",
            key_type="entity",
            use_case="defer",
            default_config=policy,
            shadow_comparator=compare,
        )
        events.append("returned")
        return result

    with cache.enable():
        task = executor.task(caller())
        executor.drain()
        if mode != "served":
            assert "read" in events and "source" not in events
            gate.set_result(None)
            executor.drain()
        assert task.result() == 1
    phase = "dump" if mode == "fill" else "compare"
    assert events.index("returned") < events.index(phase)
    if mode == "served":
        assert events.index("returned") < events.index("source")


@pytest.mark.parametrize("cancel_first", [False, True])
def test_shadow_waits_for_cross_scope_and_late_followers(scheduled, cancel_first):
    executor = scheduled
    gate = executor.future()
    events, followers = [], []
    joining = False
    spawned = False

    class Redis:
        def read(self, request, context):
            return Miss("value_absent")

        def write(self, request):
            events.append("write")

    class Serializer:
        def dump(self, value):
            events.append("dump")
            return "1"

    def observe(event):
        nonlocal spawned
        if joining and not spawned and event["event"] == "request" and event.get("layer") == "request_local":
            spawned = True
            followers.append(executor.task(caller("C")))

    cache = DialCache(clock=executor.clock, redis=Redis(), serializer=Serializer(), metrics=observe)
    policy = Policy(
        request_local=True, ttl_sec={"local": 10, "remote": 10}, ramp={"remote": 0}, shadow={"ramp": 100}
    )

    async def source():
        events.append("source")
        await gate
        return 1

    async def caller(name):
        value = await cache.get_or_load(
            source, key="a", key_type="entity", use_case="followers", default_config=policy
        )
        events.append(name)
        return value

    with cache.enable():
        first = executor.task(caller("A"))
        executor.drain()
        if cancel_first:
            first.cancel()
            executor.drain()
            assert first.cancelled()
    with cache.enable():
        joining = True
        second = executor.task(caller("B"))
        executor.drain()
        late = executor.task(caller("D"))
        executor.drain()
        assert len(followers) == 1
        gate.set_result(None)
        executor.drain()
        assert second.result() == late.result() == followers[0].result() == 1
    assert events.count("source") == 1
    for name in ("B", "C", "D") if cancel_first else ("A", "B", "C", "D"):
        assert events.index(name) < events.index("dump")
    assert cache.get_coalescing_state()["process"]["active_leaders"] == 0


def test_independent_same_key_source_does_not_delay_completed_shadow(executor):
    gates = [executor.future(), executor.future()]
    events = []

    class Redis:
        def read(self, request, context):
            return Miss("value_absent")

        def write(self, request):
            events.append("write")

    cache = DialCache(clock=executor.clock, redis=Redis(), metrics=lambda event: None)
    policy = Policy(
        request_local=True, coalesce=False, ttl_sec={"remote": 10}, ramp={"remote": 0}, shadow={"ramp": 100}
    )

    async def caller(index):
        value = await cache.get_or_load(
            lambda: gates[index], key="a", key_type="entity", use_case="independent", default_config=policy
        )
        events.append(index)
        return value

    with cache.enable():
        first, second = executor.task(caller(0)), executor.task(caller(1))
        executor.drain()
        gates[0].set_result(1)
        executor.drain()
        assert first.result() == 1 and not second.done()
        assert events == [0, "write"]
        gates[1].set_result(2)
        executor.drain()
        assert second.result() == 2


@pytest.mark.parametrize("served", [False, True])
def test_shadow_delivery_wait_preserves_budget_origin(executor, served):
    events = []

    class Redis:
        def read(self, request, context):
            return Frame(int(executor.clock.wall_ms()), "1") if served else Miss("value_absent")

        def write(self, request):
            events.append({"event": "write"})

    cache = DialCache(clock=executor.clock, redis=Redis(), metrics=events.append)

    async def caller():
        value = await cache.get_or_load(
            lambda: 1,
            key="a",
            key_type="entity",
            use_case="delivery-budget",
            fallback_timeout_ms=10,
            default_config=Policy(
                ttl_sec={"remote": 10}, ramp={"remote": 100 if served else 0}, shadow={"ramp": 100}
            ),
        )
        executor.clock.consume(10)
        return value

    with cache.enable():
        assert executor.finish(caller()) == 1
    assert [e["outcome"] for e in events if e["event"] == "shadowValidation"] == [
        "match" if served else "timeout"
    ]
    assert not [e for e in events if e["event"] == "write"]


@pytest.mark.parametrize("shadow", [False, True])
def test_cancelled_follower_markers_are_collectible_during_unbounded_source(scheduled, monkeypatch, shadow):
    import gc
    import weakref

    executor = scheduled
    references = []
    create_future = executor.loop.create_future

    def observed_future():
        future = create_future()
        references.append(weakref.ref(future))
        return future

    monkeypatch.setattr(executor.loop, "create_future", observed_future)
    gate = executor.future()

    class Redis:
        def read(self, request, context):
            return Miss("value_absent")

        def write(self, request):
            pass

    cache = DialCache(clock=executor.clock, redis=Redis(), metrics=lambda event: None)
    policy = Policy(
        request_local=True,
        ttl_sec={"local": 10, "remote": 10},
        ramp={"remote": 0},
        shadow={"ramp": 100 if shadow else 0},
    )

    async def call():
        return await cache.get_or_load(
            lambda: gate,
            key="a",
            key_type="entity",
            use_case="churn",
            fallback_timeout_ms=None,
            default_config=policy,
        )

    with cache.enable():
        first = executor.task(call())
        executor.drain()
    with cache.enable():
        # This request leader transfers its delivery group into the process
        # flight. Later request followers must not retain completed markers in
        # either the original group or its destination.
        second = executor.task(call())
        executor.drain()
        gc.collect()
        baseline = sum(ref() is not None for ref in references)
        for _ in range(3):
            for _ in range(100):
                follower = executor.task(call())
                executor.drain()
                follower.cancel()
                executor.drain()
                assert follower.cancelled()
            gc.collect()
            assert sum(ref() is not None for ref in references) <= baseline + 2
        gate.set_result(1)
        executor.drain()
        assert first.result() == second.result() == 1
