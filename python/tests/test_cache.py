"""Python binding checks independent of the portable observation corpus."""

import pytest
from formal.executor import Executor

from dialcache import (
    ConfigError,
    DialCache,
    FallbackTimeoutError,
    Key,
    MissingRemoteError,
    Policy,
    UseCaseIsAlreadyRegisteredError,
    UseCaseNameIsReservedError,
)
from dialcache.protocol import Frame


@pytest.fixture
def executor():
    result = Executor()
    try:
        yield result
    finally:
        result.close()


def test_disabled_calls_skip_keys_policy_coalescing_and_default_deadline(executor):
    calls = []
    gate = executor.future()

    def forbidden(*args):
        raise AssertionError("Disabled invocation touched cache plumbing")

    cache = DialCache(policy_provider=forbidden, clock=executor.clock)

    @cache.cached(key_type="user", cache_key=forbidden, default_config=Policy.enabled(10))
    async def source(user_id):
        calls.append(user_id)
        return await gate

    first = executor.task(source("a"))
    second = executor.task(source("a"))
    executor.drain()
    assert calls == ["a", "a"]
    assert cache.get_coalescing_state()["process"]["active_leaders"] == 0
    executor.clock.advance(120_000)
    assert not first.done() and not second.done()
    gate.set_result(7)
    executor.drain()
    assert first.result() == second.result() == 7


@pytest.mark.parametrize("cancel_first", [True, False])
def test_caller_cancellation_cannot_cancel_shared_source(executor, cancel_first):
    gate = executor.future()
    calls = []
    cache = DialCache(clock=executor.clock)

    async def source():
        calls.append(1)
        return await gate

    def call():
        return cache.get_or_load(
            source, key="a", key_type="user", use_case="cancellation", default_config=Policy.enabled(10)
        )

    with cache.enable():
        first, second = executor.task(call()), executor.task(call())
        executor.drain()
        assert len(calls) == 1
        cancelled, survivor = (first, second) if cancel_first else (second, first)
        cancelled.cancel()
        executor.drain()
        assert cancelled.cancelled()
        assert not gate.cancelled()
        assert not survivor.done()
        gate.set_result({"id": "a"})
        executor.drain()
        assert survivor.result() == {"id": "a"}
        assert executor.finish(call()) == {"id": "a"}
        assert len(calls) == 1


def test_source_default_deadline_exact_boundary_and_late_value_not_published(executor):
    gates = []
    cache = DialCache(clock=executor.clock)

    async def source():
        gate = executor.future()
        gates.append(gate)
        return await gate

    def call(**options):
        return cache.get_or_load(
            source,
            key="a",
            key_type="user",
            use_case="deadline",
            default_config=Policy.enabled(10),
            **options,
        )

    with cache.enable():
        first = executor.task(call())
        executor.drain()
        executor.clock.advance(59_999)
        executor.drain()
        assert not first.done()
        executor.clock.advance(1)
        executor.drain()
        assert isinstance(first.exception(), FallbackTimeoutError)
        assert first.exception().timeout_ms == 60_000
        assert cache.get_coalescing_state()["process"]["active_leaders"] == 0
        gates[0].set_result("late")
        executor.drain()
        second = executor.task(call(fallback_timeout_ms=None))
        executor.drain()
        assert len(gates) == 2
        executor.clock.advance(120_000)
        executor.drain()
        assert not second.done()
        gates[1].set_result("fresh")
        executor.drain()
        assert second.result() == "fresh"
        assert executor.finish(call()) == "fresh"


def test_elapsed_deadline_wins_when_source_settles_before_timer_delivery(executor):
    cache = DialCache(clock=executor.clock)

    def source():
        executor.clock.consume(10)
        return "too late"

    with cache.enable():
        task = executor.task(
            cache.get_or_load(source, key="a", key_type="user", use_case="elapsed", fallback_timeout_ms=10)
        )
        executor.drain()
    assert isinstance(task.exception(), FallbackTimeoutError)


def test_default_remote_read_budget_aborts_wait_and_never_refills_failed_read(executor):
    gate = executor.future()
    contexts = []
    writes = []

    class Remote:
        def read(self, request, context):
            contexts.append(context)
            return gate

        def write(self, request):
            writes.append(request)

    cache = DialCache(redis=Remote(), clock=executor.clock)
    with cache.enable():
        call = executor.task(
            cache.get_or_load(
                lambda: "source",
                key="a",
                key_type="user",
                use_case="read-budget",
                default_config=Policy.enabled(10),
            )
        )
        executor.drain()
        assert contexts[0].timeout_ms == 50
        executor.clock.advance(49)
        executor.drain()
        assert not call.done()
        executor.clock.advance(1)
        executor.drain()
        assert call.result() == "source"
        assert contexts[0].signal.aborted
        assert writes == []
        gate.set_result(Frame(int(executor.clock.wall_ms()), '"late"'))
        executor.drain()
        assert writes == []
        assert (
            executor.finish(
                cache.get_or_load(
                    lambda: "unexpected",
                    key="a",
                    key_type="user",
                    use_case="read-budget",
                    default_config=Policy.enabled(10),
                )
            )
            == "source"
        )


def test_coalescing_disabled_gives_each_caller_its_own_deadline_and_publication(executor):
    gates = []
    cache = DialCache(clock=executor.clock)
    policy = Policy(ttl_sec={"local": 60}, request_local=True, coalesce=False)

    async def source():
        gate = executor.future()
        gates.append(gate)
        return await gate

    def call(timeout=10):
        return cache.get_or_load(
            source,
            key="a",
            key_type="user",
            use_case="independent",
            default_config=policy,
            fallback_timeout_ms=timeout,
        )

    with cache.enable():
        first = executor.task(call())
        executor.drain()
        executor.clock.advance(5)
        second = executor.task(call())
        executor.drain()
        assert len(gates) == 2
        assert cache.get_coalescing_state()["process"]["active_leaders"] == 0
        executor.clock.advance(5)
        executor.drain()
        assert isinstance(first.exception(), FallbackTimeoutError)
        assert not second.done()
        gates[1].set_result("second")
        executor.drain()
        gates[0].set_result("too late")
        executor.drain()
        assert second.result() == "second"
        assert executor.finish(call()) == "second"
        assert len(gates) == 2


async def test_gcache_argument_binding_defaults_adapters_and_ignored_arguments():
    cache = DialCache()
    calls = []
    adapters = []

    def adapt_role(role):
        adapters.append(role)
        return role.lower()

    @cache.cached(
        key_type="user",
        id_arg=("user", lambda user: user["id"]),
        arg_adapters={"role": adapt_role},
        ignore_args=["trace_id"],
        default_config=Policy(request_local=True),
    )
    async def load(user, role="member", trace_id=None):
        calls.append((user, role, trace_id))
        return len(calls)

    user = {"id": "u1", "ignored": object()}
    async with cache.enable():
        assert await load(user) == 1
        assert await load(user=user, role="MEMBER", trace_id="trace") == 1
        assert await load(user, role="admin") == 2
        async with cache.enable(False):
            assert await load(user) == 3
        assert await load(user) == 1
    assert len(calls) == 3
    assert adapters == ["member", "MEMBER", "admin", "member"]
    assert load.__name__ == "load"


async def test_explicit_cache_key_and_sync_loader_are_awaitable():
    cache = DialCache()
    seen = []

    @cache.cached(
        key_type="sum",
        cache_key=lambda a, b: {"id": a, "args": {"b": b}},
        default_config=Policy(request_local=True),
    )
    def add(a, b):
        seen.append((a, b))
        return a + b

    with cache.enable():
        assert await add(1, 2) == await add(1, 2) == 3
        assert await add(1, 3) == 4
    assert seen == [(1, 2), (1, 3)]


async def test_runtime_malformed_flag_bypasses_existing_cache_without_erasing_it():
    runtime = None
    calls = []
    cache = DialCache(policy_provider=lambda key: runtime)

    @cache.cached(key_type="user", id_arg="id", default_config=Policy.enabled(60))
    async def load(id):
        calls.append(id)
        return len(calls)

    with cache.enable():
        assert await load("a") == 1
        runtime = {"requestLocal": None}
        assert await load("a") == 2
        assert await load("a") == 3
        runtime = None
        assert await load("a") == 1
    assert len(calls) == 3


async def test_metrics_failures_do_not_change_source_or_hit_results():
    class Observer:
        def observe(self, event):
            raise RuntimeError("metrics backend unavailable")

    cache = DialCache(metrics=Observer())
    calls = []

    def load():
        calls.append(1)
        return None

    with cache.enable():
        for _ in range(2):
            assert (
                await cache.get_or_load(
                    load, key="a", key_type="user", use_case="observer", default_config=Policy.enabled(60)
                )
                is None
            )
    assert len(calls) == 1


def test_default_recovery_admits_timeout_and_preserves_other_source_errors(executor):
    class Remote:
        writes = 0

        def read(self, request, context):
            return Frame(int(executor.clock.wall_ms()) - 2_000, '"stale"')

        def write(self, request):
            self.writes += 1

    remote = Remote()
    cache = DialCache(redis=remote, clock=executor.clock)
    policy = Policy(ttl_sec={"remote": 1}, stale_on_error_max_age_sec=10)
    failure = ValueError("permission denied")

    def rejected():
        raise failure

    with cache.enable():
        first = executor.task(
            cache.get_or_load(rejected, key="a", key_type="user", use_case="recovery", default_config=policy)
        )
        executor.drain()
        assert first.exception() is failure
        gate = executor.future()
        second = executor.task(
            cache.get_or_load(
                lambda: gate,
                key="a",
                key_type="user",
                use_case="recovery",
                default_config=policy,
                fallback_timeout_ms=10,
            )
        )
        executor.drain()
        executor.clock.advance(10)
        executor.drain()
        assert second.result() == "stale"
        assert remote.writes == 0
        gate.set_result("late")
        executor.drain()


async def test_aget_uses_structured_identity_and_rejects_foreign_namespace():
    cache = DialCache(namespace="service")
    calls = []

    def source():
        calls.append(1)
        return len(calls)

    key = Key("service", "user", "a", "structured")
    with cache.enable():
        assert await cache.aget(key, source, default_config=Policy(request_local=True)) == 1
        assert await cache.aget(key, source, default_config=Policy(request_local=True)) == 1
        assert (
            await cache.aget(
                Key("other", "user", "a", "structured"), source, default_config=Policy(request_local=True)
            )
            == 2
        )


@pytest.mark.parametrize("options", [{}, {"cache_key": lambda x: x, "id_arg": "x"}])
def test_decorator_requires_exactly_one_identity_source(options):
    with pytest.raises(ConfigError):
        DialCache().cached(key_type="user", **options)


def test_registration_uses_public_owned_error_types():
    cache = DialCache()
    cache.cached(key_type="user", id_arg="id", use_case="unique")(lambda id: id)
    with pytest.raises(UseCaseIsAlreadyRegisteredError):
        cache.cached(key_type="user", id_arg="id", use_case="unique")(lambda id: id)
    with pytest.raises(UseCaseNameIsReservedError):
        cache.cached(key_type="user", id_arg="id", use_case="watermark")(lambda id: id)


async def test_missing_remote_maintenance_error_is_public():
    with pytest.raises(MissingRemoteError):
        await DialCache().invalidate_remote("user", "a")


@pytest.mark.parametrize(
    "compression",
    [
        None,
        1,
        "zstd",
        {"maximum": 10},
        {"threshold_bytes": 0},
        {"threshold_bytes": True},
        {"level": 0},
        {"level": 23},
        {"level": 1.5},
    ],
)
def test_compression_settings_fail_at_construction(compression):
    with pytest.raises(ConfigError):
        DialCache(compression=compression)


def test_default_shadow_comparison_distinguishes_nested_boolean_from_number(executor):
    events = []

    class Remote:
        def read(self, request, context):
            return Frame(int(executor.clock.wall_ms()), '{"values":[true]}')

    cache = DialCache(redis=Remote(), clock=executor.clock, metrics=events.append)
    policy = Policy(ttl_sec={"remote": 10}, shadow={"ramp": 100})
    with cache.enable():
        result = executor.finish(
            cache.get_or_load(
                lambda: {"values": [1]},
                key="a",
                key_type="user",
                use_case="shadow-equality",
                default_config=policy,
            )
        )
        executor.drain()
        assert result == {"values": [True]}
        assert [event["outcome"] for event in events if event["event"] == "shadowValidation"] == ["mismatch"]
