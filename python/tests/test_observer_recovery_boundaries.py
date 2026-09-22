"""Observer privacy and synchronous recovery ownership regressions."""

import asyncio
import inspect
import json

import pytest
from formal.executor import Executor

from dialcache import DialCache, Policy
from dialcache.protocol import Frame


@pytest.fixture
def executor():
    instance = Executor()
    try:
        yield instance
    finally:
        instance.close()


@pytest.mark.parametrize("log", [False, True])
@pytest.mark.parametrize("observer_failure", [False, True])
def test_mismatch_details_are_logger_only(executor, log, observer_failure):
    events, warnings = [], []

    def observer(event):
        events.append(event)
        if observer_failure:
            raise RuntimeError("metrics unavailable")

    class Logger:
        def warning(self, *args):
            warnings.append(args)
            if observer_failure:
                raise RuntimeError("logger unavailable")

    class Redis:
        def read(self, request, context):
            return Frame(int(executor.clock.wall_ms()), '"cached-synthetic-credential"')

    cache = DialCache(redis=Redis(), clock=executor.clock, metrics=observer, logger=Logger())
    policy = Policy(ttl_sec={"remote": 10}, shadow={"ramp": 100, "log_mismatches": log})
    with cache.enable():
        result = executor.finish(
            cache.get_or_load(
                lambda: "source-synthetic-credential",
                key="entity-synthetic-id",
                key_type="entity",
                use_case="privacy",
                default_config=policy,
            )
        )
    executor.drain()
    assert result == "cached-synthetic-credential"
    assert [e["outcome"] for e in events if e["event"] == "shadowValidation"] == ["mismatch"]
    assert [e["outcome"] for e in events if e["event"] == "shadowAge"] == ["mismatch"]
    assert not any(e["event"] == "mismatchWarning" for e in events)
    serialized = json.dumps(events)
    for sensitive in [
        "entity-synthetic-id",
        "cached-synthetic-credential",
        "source-synthetic-credential",
        "cacheKey",
        "cachedValueJson",
        "sourceValueJson",
    ]:
        assert sensitive not in serialized
    if log:
        assert len(warnings) == 1
        message, details = warnings[0]
        assert message == "DialCache shadow validation mismatch: %s"
        assert details["outcome"] == "mismatch"
        assert "entity-synthetic-id" in details["cacheKey"]
        assert details["cachedValueJson"] == '"cached-synthetic-credential"'
        assert details["sourceValueJson"] == '"source-synthetic-credential"'
    else:
        assert warnings == []


def failing_recovery_call(executor, cache, failure):
    def source():
        raise failure

    with cache.enable():
        with pytest.raises(ValueError) as caught:
            executor.finish(
                cache.get_or_load(
                    source,
                    key="id",
                    key_type="entity",
                    use_case="recovery",
                    default_config=Policy(ttl_sec={"remote": 1}, stale_on_error_max_age_sec=10),
                )
            )
        assert caught.value is failure
    executor.drain()


def recovery_cache(executor, predicate):
    class Redis:
        def read(self, request, context):
            return Frame(int(executor.clock.wall_ms()) - 2000, '"stale"')

    return DialCache(redis=Redis(), clock=executor.clock, should_attempt_stale_recovery=predicate)


def test_denied_async_recovery_starts_no_work(executor):
    started, returned = [], []
    gate = executor.future()

    async def predicate(error):
        started.append(error)
        await gate
        return True

    def classify(error):
        result = predicate(error)
        returned.append(result)
        return result

    cache = recovery_cache(executor, classify)
    failure = ValueError("source failure")
    for _ in range(20):
        failing_recovery_call(executor, cache, failure)
    assert started == []
    assert asyncio.all_tasks(executor.loop) == set()
    assert all(inspect.getcoroutinestate(c) == inspect.CORO_CLOSED for c in returned)


def test_denied_custom_recovery_awaitable_is_not_driven(executor):
    attempts = []

    class Awaitable:
        def __await__(self):
            attempts.append("started")
            yield
            return True

    cache = recovery_cache(executor, lambda error: Awaitable())
    failing_recovery_call(executor, cache, ValueError("source failure"))
    assert attempts == []
    assert asyncio.all_tasks(executor.loop) == set()


def test_borrowed_started_coroutine_stays_application_owned(executor):
    actions = []

    async def work():
        actions.append("started")
        await asyncio.sleep(0)
        actions.append("finished")
        return True

    coroutine = work()
    coroutine.send(None)
    cache = recovery_cache(executor, lambda error: coroutine)
    failing_recovery_call(executor, cache, ValueError("source failure"))
    assert actions == ["started"]
    assert executor.finish(coroutine) is True
    assert actions == ["started", "finished"]


@pytest.mark.parametrize("kind", ["future", "task"])
@pytest.mark.parametrize("settlement", ["failure", "cancel"])
@pytest.mark.parametrize("already_done", [False, True])
def test_denied_recovery_observes_borrowed_future_without_owning_it(executor, kind, settlement, already_done):
    observed = []

    class ObserveException:
        def exception(self):
            observed.append("observed")
            return super().exception()

    class Future(ObserveException, asyncio.Future):
        pass

    class Task(ObserveException, asyncio.Task):
        pass

    failure = RuntimeError("borrowed task failure")
    gate = executor.future()

    async def work():
        await gate
        raise failure

    borrowed = Future(loop=executor.loop) if kind == "future" else Task(work(), loop=executor.loop)
    executor.drain()

    def settle():
        if settlement == "cancel":
            borrowed.cancel()
        elif kind == "future":
            borrowed.set_exception(failure)
        else:
            gate.set_result(None)
        executor.drain()

    if already_done:
        settle()
    cache = recovery_cache(executor, lambda error: borrowed)
    failing_recovery_call(executor, cache, ValueError("source failure"))
    assert asyncio.all_tasks(executor.loop) == ({borrowed} if kind == "task" and not already_done else set())
    assert borrowed.done() is already_done
    if not already_done:
        settle()
    assert borrowed.cancelled() is (settlement == "cancel")
    assert bool(observed) is (settlement == "failure")
