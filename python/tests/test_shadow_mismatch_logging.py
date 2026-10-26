"""Confirmed-mismatch warnings: fields per leaf, the hook, failures and their outcome event."""

from __future__ import annotations

import asyncio
import gc
import json
import weakref

import pytest
from formal.executor import Executor

from dialcache import UNDEFINED, ConfigError, DialCache, Policy, _shadow_log
from dialcache import cache as cache_module
from dialcache.protocol import Frame
from dialcache.serializer import JSON_UNDEFINED_SENTINEL

MESSAGE = "DialCache shadow validation mismatch: %s"
CACHED = {"id": "123", "version": 1}
SOURCE = {"id": "123", "version": 2}
AGE_MS = 30_500
PATH_FIELDS = {"mismatchPaths": ["/version"], "mismatchPathCount": 1}
DIFF_JSON = '[{"path":"/version","cached":1,"source":2}]'
VALUE_FIELDS = {"cachedValueJson": '{"id":"123","version":1}', "sourceValueJson": '{"id":"123","version":2}'}
EVERY_FIELD = {**PATH_FIELDS, "diffJson": DIFF_JSON, **VALUE_FIELDS}


@pytest.fixture
def executor():
    instance = Executor()
    try:
        yield instance
    finally:
        instance.close()


class Logger:
    """Records each warning, then fails or returns as the test asks."""

    def __init__(self, deliver=None):
        self.calls = []
        self.deliver = deliver

    def warning(self, *args):
        self.calls.append(args)
        if self.deliver is not None:
            return self.deliver()
        return None

    def warnings(self):
        return [details for message, details in self.calls if message == MESSAGE]


class Harness:
    def __init__(
        self,
        executor,
        *,
        logger=None,
        provider=None,
        payload=None,
        namespace="urn",
        shadow_max_in_flight=1,
        metrics=None,
    ):
        self.executor = executor
        self.events = []
        self.logger = logger if logger is not None else Logger()
        self.payload = json.dumps(CACHED, separators=(",", ":")) if payload is None else payload
        harness = self

        class Redis:
            def read(self, request, context):
                return Frame(int(executor.clock.wall_ms()) - AGE_MS, harness.payload)

            def write(self, request):
                return None

        self.cache = DialCache(
            namespace=namespace,
            redis=Redis(),
            clock=executor.clock,
            metrics=metrics or self.events.append,
            logger=self.logger,
            policy_provider=provider,
            shadow_max_in_flight=shadow_max_in_flight,
        )

    def get(self, shadow, *, source=SOURCE, dark=False, key="123", use_case="Mismatch", **options):
        policy = {
            "ttl_sec": {"remote": 60},
            "ramp": {"remote": 0 if dark else 100},
            "shadow": {"ramp": 100, **shadow},
        }

        async def call():
            with self.cache.enable():
                return await self.cache.get_or_load(
                    lambda: source,
                    key=key,
                    key_type="user_id",
                    use_case=use_case,
                    default_config=policy,
                    **options,
                )

        return self.executor.finish(call())

    def named(self, name):
        return [event for event in self.events if event["event"] == name]

    def outcomes(self, name):
        return [event["outcome"] for event in self.named(name)]

    def logging_events(self):
        return self.named("shadowMismatchLogging")

    def config_errors(self):
        return [event for event in self.named("error") if event["error"] == "config_resolution"]


def labels(use_case="Mismatch", namespace="urn"):
    return {"cacheNamespace": namespace, "useCase": use_case, "keyType": "user_id"}


def logging_event(outcome, use_case="Mismatch", namespace="urn"):
    return {"event": "shadowMismatchLogging", **labels(use_case, namespace), "outcome": outcome}


def warning(fields, *, use_case="Mismatch", namespace="urn", key="123"):
    return {
        **labels(use_case, namespace),
        "outcome": "mismatch",
        "cachedValueAgeSeconds": AGE_MS / 1000,
        "cacheKey": f"{namespace}:user_id:{key}#{use_case}",
        **fields,
    }


@pytest.mark.parametrize("dark", [False, True], ids=["served-hit", "ramped-down"])
def test_logs_every_field_in_order_for_the_shorthand_and_one_logged_event(executor, dark):
    harness = Harness(executor)

    result = harness.get({"logMismatches": True}, dark=dark)

    assert result == (SOURCE if dark else CACHED)
    assert harness.outcomes("shadowValidation") == ["mismatch"]
    assert harness.logger.calls == [(MESSAGE, warning(EVERY_FIELD))]
    assert list(harness.logger.calls[0][1]) == [
        "cacheNamespace",
        "useCase",
        "keyType",
        "outcome",
        "cachedValueAgeSeconds",
        "cacheKey",
        "mismatchPaths",
        "mismatchPathCount",
        "diffJson",
        "cachedValueJson",
        "sourceValueJson",
    ]
    assert harness.logging_events() == [logging_event("logged")]


@pytest.mark.parametrize(
    ("shadow", "fields"),
    [
        ({"mismatch_logging": {"diff": "paths"}}, PATH_FIELDS),
        ({"mismatchLogging": {"diff": "values", "value": False}}, {**PATH_FIELDS, "diffJson": DIFF_JSON}),
        ({"mismatch_logging": {"value": True}}, VALUE_FIELDS),
        ({"mismatch_logging": {"value": True, "diff": "paths"}}, {**PATH_FIELDS, **VALUE_FIELDS}),
    ],
    ids=["paths", "values-without-value", "value", "value-with-paths"],
)
def test_logs_exactly_the_fields_each_leaf_selects(executor, shadow, fields):
    harness = Harness(executor)

    harness.get(shadow)

    assert harness.logger.warnings() == [warning(fields)]
    assert list(harness.logger.warnings()[0])[6:] == list(fields)
    assert harness.logging_events() == [logging_event("logged")]


def test_logs_the_value_age_the_verdict_observed(executor):
    harness = Harness(executor)

    harness.get({"mismatch_logging": {"diff": "paths"}})

    assert [event["seconds"] for event in harness.named("shadowAge")] == [30.5]
    assert harness.logger.warnings()[0]["cachedValueAgeSeconds"] == 30.5


def test_emits_one_event_per_confirmed_mismatch_after_its_verdict_and_none_for_a_match(executor):
    harness = Harness(executor)
    events = harness.events
    harness.logger.deliver = lambda: events.append({"event": "warning"})
    shadow = {"mismatch_logging": {"diff": "paths"}}

    harness.get(shadow, source=CACHED)
    assert harness.outcomes("shadowValidation") == ["match"]
    assert harness.logging_events() == []
    harness.get(shadow, key="b")
    harness.get(shadow, key="c")

    assert harness.outcomes("shadowValidation") == ["match", "mismatch", "mismatch"]
    assert harness.logging_events() == [logging_event("logged"), logging_event("logged")]
    sequence = [
        event["event"]
        for event in events
        if event["event"] in ("shadowValidation", "shadowAge", "warning", "shadowMismatchLogging")
    ]
    assert sequence == [
        "shadowValidation",
        "shadowAge",
        *["shadowValidation", "shadowAge", "warning", "shadowMismatchLogging"] * 2,
    ]


@pytest.mark.parametrize("shadow", [{}, {"log_mismatches": False}, {"mismatch_logging": {}}])
def test_logs_nothing_and_emits_no_event_with_logging_off(executor, shadow):
    harness = Harness(executor)

    harness.get(shadow)

    assert harness.outcomes("shadowValidation") == ["mismatch"]
    assert harness.logger.calls == []
    assert harness.logging_events() == []


def test_builds_labels_from_the_key_rather_than_from_mutated_metric_events(executor):
    def mutate(event):
        harness.events.append(dict(event))
        event["cacheNamespace"] = "mutated-by-metrics"
        event["cacheKey"] = "injected-by-metrics"

    harness = Harness(executor, namespace="private-namespace", metrics=mutate)

    harness.get({"logMismatches": True})

    assert harness.logger.warnings() == [warning(EVERY_FIELD, namespace="private-namespace")]
    assert harness.logging_events() == [logging_event("logged", namespace="private-namespace")]


def test_logs_the_documented_get_user_example(executor):
    cached = {
        "id": "u_123",
        "email": "ana@example.com",
        "plan": "free",
        "roles": ["viewer"],
        "profile": {"name": "Ana", "locale": "en-US"},
    }
    source = {
        "id": "u_123",
        "email": "ana@example.com",
        "plan": "pro",
        "roles": ["viewer", "editor"],
        "profile": {"name": "Ana", "locale": "en-GB", "timezone": "Europe/London"},
    }
    paths = {
        "mismatchPaths": ["/plan", "/profile/locale", "/profile/timezone", "/roles"],
        "mismatchPathCount": 4,
    }
    diff_json = (
        '[{"path":"/plan","cached":"free","source":"pro"},'
        '{"path":"/profile/locale","cached":"en-US","source":"en-GB"},'
        '{"path":"/profile/timezone","source":"Europe/London"},'
        '{"path":"/roles","cached":["viewer"],"source":["viewer","editor"]}]'
    )
    for diff, fields in [("paths", paths), ("values", {**paths, "diffJson": diff_json})]:
        harness = Harness(Executor(), namespace="users-api", payload=json.dumps(cached))
        try:
            harness.get({"mismatch_logging": {"diff": diff}}, source=source, key="u_123", use_case="GetUser")
            assert harness.logger.warnings() == [
                warning(fields, use_case="GetUser", namespace="users-api", key="u_123")
            ]
        finally:
            harness.executor.close()


def test_clamps_the_key_and_every_value_field(executor):
    key = "k" * 2148
    cached = {"id": key, "content": "🙂" * 8192}
    source = {"id": key, "content": "s" * 8193}
    harness = Harness(executor, payload=json.dumps(cached))

    harness.get({"log_mismatches": True}, source=source, key=key)

    (details,) = harness.logger.warnings()
    assert "loggingOutcome" not in details
    for field, limit in [("cacheKey", 2048), ("cachedValueJson", 8192), ("sourceValueJson", 8192)]:
        assert len(details[field].encode()) <= limit
        assert details[field].endswith("...[truncated]")
        assert "�" not in details[field]
    assert details["mismatchPaths"] == ["/content"]
    assert details["mismatchPathCount"] == 1
    assert len(details["diffJson"].encode()) <= 8192
    (entry,) = json.loads(details["diffJson"])
    assert list(entry) == ["path", "cached", "source"]
    for side in (entry["cached"], entry["source"]):
        assert len(side.encode()) <= 1024
        assert side.startswith('"') and side.endswith("...[truncated]")
        assert "�" not in side
    assert harness.logging_events() == [logging_event("logged")]


@pytest.mark.parametrize("api", ["cached", "get_or_load"])
def test_logs_hook_entries_in_place_of_the_built_in_walk(executor, api, monkeypatch):
    harness = Harness(executor)
    calls = []

    def hook(cached, source):
        calls.append((cached, source))
        return [
            {"path": "/custom", "cached": "c", "source": "s"},
            {"path": "/only-path"},
            {"path": "/one-side", "source": {"nested": True}},
        ]

    def walk(cached, source):
        raise AssertionError("the built-in walk ran")

    monkeypatch.setattr(_shadow_log, "_walk", walk)
    shadow = {"ttl_sec": {"remote": 60}, "shadow": {"ramp": 100, "log_mismatches": True}}
    if api == "cached":

        @harness.cache.cached(
            key_type="user_id",
            cache_key=lambda: "123",
            use_case="Mismatch",
            default_config=shadow,
            shadow_mismatch_diff=hook,
        )
        async def load():
            return SOURCE

        async def call():
            with harness.cache.enable():
                return await load()
    else:

        async def call():
            with harness.cache.enable():
                return await harness.cache.get_or_load(
                    lambda: SOURCE,
                    key="123",
                    key_type="user_id",
                    use_case="Mismatch",
                    default_config=shadow,
                    shadow_mismatch_diff=hook,
                )

    assert executor.finish(call()) == CACHED
    assert calls == [(CACHED, SOURCE)]
    assert harness.logger.warnings() == [
        warning(
            {
                "mismatchPaths": ["/custom", "/only-path", "/one-side"],
                "mismatchPathCount": 3,
                "diffJson": '[{"path":"/custom","cached":"c","source":"s"},{"path":"/only-path"},'
                '{"path":"/one-side","source":{"nested":true}}]',
                **VALUE_FIELDS,
            }
        )
    ]
    assert harness.logging_events() == [logging_event("logged")]


def test_never_runs_the_hook_at_value_alone(executor):
    harness = Harness(executor)
    calls = []

    harness.get(
        {"mismatch_logging": {"value": True}}, shadow_mismatch_diff=lambda c, s: calls.append(1) or []
    )

    assert harness.logger.warnings() == [warning(VALUE_FIELDS)]
    assert calls == []


async def async_hook(cached, source):
    return [{"path": "/version"}]


def raising_hook(cached, source):
    raise RuntimeError("diff hook unavailable")


@pytest.mark.parametrize("hook", [raising_hook, async_hook], ids=["raises", "coroutine"])
def test_logs_null_diff_fields_and_hook_error_without_touching_the_verdict(executor, hook):
    harness = Harness(executor)

    assert harness.get({"log_mismatches": True}, shadow_mismatch_diff=hook) == CACHED

    assert harness.outcomes("shadowValidation") == ["mismatch"]
    (details,) = harness.logger.warnings()
    assert details == warning(
        {
            "mismatchPaths": None,
            "mismatchPathCount": None,
            "diffJson": None,
            **VALUE_FIELDS,
            "loggingOutcome": "hook_error",
        }
    )
    assert list(details)[-1] == "loggingOutcome"
    assert harness.logging_events() == [logging_event("hook_error")]


@pytest.mark.parametrize("comparator", [None, lambda cached, source: False], ids=["default", "custom"])
def test_logs_render_error_for_a_source_value_without_a_json_rendering(executor, comparator):
    harness = Harness(executor)
    options = {} if comparator is None else {"shadow_comparator": comparator}

    harness.get({"log_mismatches": True}, source={"id": "123", "version": {1}}, dark=False, **options)

    assert harness.outcomes("shadowValidation") == ["mismatch"]
    assert harness.logger.warnings() == [
        warning(
            {
                "mismatchPaths": None,
                "mismatchPathCount": None,
                "diffJson": None,
                "cachedValueJson": '{"id":"123","version":1}',
                "sourceValueJson": None,
                "loggingOutcome": "render_error",
            }
        )
    ]
    assert harness.logging_events() == [logging_event("render_error")]


def test_logs_a_cached_undefined_entry_as_an_absent_side(executor):
    harness = Harness(executor, payload=JSON_UNDEFINED_SENTINEL)

    assert harness.get({"log_mismatches": True}, source={"id": "123"}) is UNDEFINED

    assert harness.outcomes("shadowValidation") == ["mismatch"]
    assert harness.logger.warnings() == [
        warning(
            {
                "mismatchPaths": [""],
                "mismatchPathCount": 1,
                "diffJson": '[{"path":"","source":{"id":"123"}}]',
                "cachedValueJson": None,
                "sourceValueJson": '{"id":"123"}',
            }
        )
    ]
    assert harness.logging_events() == [logging_event("logged")]


def test_passes_an_absent_cached_side_to_the_hook_as_the_raw_undefined(executor):
    inputs = []

    def hook(cached, source):
        inputs.append((cached, source))
        return [{"path": "", "source": source}]

    harness = Harness(executor, payload=JSON_UNDEFINED_SENTINEL)

    result = harness.get(
        {"mismatch_logging": {"diff": "values"}}, source={"id": "123"}, shadow_mismatch_diff=hook
    )

    assert result is UNDEFINED
    # D13: the hook receives the raw values, so an absent side stays UNDEFINED
    # rather than becoming None, which is JSON null.
    ((cached, source),) = inputs
    assert cached is UNDEFINED
    assert source == {"id": "123"}
    assert harness.logger.warnings() == [
        warning(
            {
                "mismatchPaths": [""],
                "mismatchPathCount": 1,
                "diffJson": '[{"path":"","source":{"id":"123"}}]',
            }
        )
    ]
    assert harness.logging_events() == [logging_event("logged")]


def test_logs_hook_paths_without_rendering_values_at_diff_paths(executor):
    harness = Harness(executor)

    harness.get(
        {"mismatch_logging": {"diff": "paths"}},
        source={"id": "123", "version": object()},
        shadow_mismatch_diff=lambda cached, source: [{"path": "/version"}],
    )

    assert harness.logger.warnings() == [warning(PATH_FIELDS)]
    assert harness.logging_events() == [logging_event("logged")]


def test_keeps_the_verdict_and_logs_hook_error_when_the_built_in_walk_raises(executor, monkeypatch):
    def walk(cached, source):
        raise RecursionError("walk failed")

    monkeypatch.setattr(_shadow_log, "_walk", walk)
    harness = Harness(executor)

    harness.get({"log_mismatches": True})

    assert harness.outcomes("shadowValidation") == ["mismatch"]
    assert harness.logger.warnings() == [
        warning(
            {
                "mismatchPaths": None,
                "mismatchPathCount": None,
                "diffJson": None,
                **VALUE_FIELDS,
                "loggingOutcome": "hook_error",
            }
        )
    ]
    assert harness.logging_events() == [logging_event("hook_error")]


@pytest.mark.parametrize("failing", ["clamp_utf8", "render_shadow_mismatch_log"])
def test_falls_back_to_a_metadata_warning_when_construction_raises(executor, monkeypatch, failing):
    def fail(*args):
        raise RuntimeError("preview unavailable")

    monkeypatch.setattr(cache_module, failing, fail)
    harness = Harness(executor)

    harness.get({"log_mismatches": True})

    assert harness.outcomes("shadowValidation") == ["mismatch"]
    (details,) = harness.logger.warnings()
    expected = warning({"loggingOutcome": "render_error"})
    if failing == "clamp_utf8":
        del expected["cacheKey"]
    assert details == expected
    assert harness.logging_events() == [logging_event("render_error")]


def logger_raises():
    raise RuntimeError("logger unavailable")


def logger_cancels():
    raise asyncio.CancelledError()


async def logger_coroutine_fails():
    raise RuntimeError("logger transport unavailable")


async def logger_coroutine_delivers():
    return None


class Uninspectable:
    """A logger result that raises when the awaitable check reads its class."""

    @property
    def __class__(self):
        raise RuntimeError("logger result unavailable")


@pytest.mark.parametrize(
    ("deliver", "outcome"),
    [
        (logger_raises, "logger_error"),
        (logger_cancels, "logger_error"),
        (logger_coroutine_fails, "logger_error"),
        (Uninspectable, "logger_error"),
        (logger_coroutine_delivers, "logged"),
        (lambda: "ignored", "logged"),
    ],
    ids=[
        "raises",
        "raises-cancelled",
        "coroutine-fails",
        "returns-an-uninspectable-value",
        "coroutine-delivers",
        "returns-a-value",
    ],
)
def test_records_the_logger_outcome_and_leaves_the_caller_unaffected(executor, deliver, outcome):
    harness = Harness(executor, logger=Logger(deliver))

    assert harness.get({"log_mismatches": True}) == CACHED

    assert harness.outcomes("shadowValidation") == ["mismatch"]
    assert harness.logger.calls == [(MESSAGE, warning(EVERY_FIELD))]
    assert harness.logging_events() == [logging_event(outcome)]


@pytest.mark.parametrize(
    ("settle", "outcome"),
    [
        (lambda future: future.set_result(None), "logged"),
        (lambda future: future.set_exception(RuntimeError("logger transport unavailable")), "logger_error"),
        (lambda future: future.cancel(), "logger_error"),
    ],
    ids=["resolves", "rejects", "cancelled"],
)
def test_waits_for_a_returned_future_before_recording_the_outcome(executor, settle, outcome):
    delivery = executor.future()
    harness = Harness(executor, logger=Logger(lambda: delivery))

    harness.get({"log_mismatches": True})
    assert harness.outcomes("shadowValidation") == ["mismatch"]
    assert len(harness.logger.warnings()) == 1
    assert harness.logging_events() == []

    settle(delivery)
    executor.drain()
    assert harness.logging_events() == [logging_event(outcome)]


def test_records_no_outcome_while_a_returned_future_never_settles(executor):
    harness = Harness(executor, logger=Logger(executor.future))

    harness.get({"log_mismatches": True})
    for _ in range(5):
        executor.drain()

    assert harness.outcomes("shadowValidation") == ["mismatch"]
    assert len(harness.logger.warnings()) == 1
    assert harness.logging_events() == []


class Watched(dict):
    """A compared value the test can watch for collection."""


def test_holds_no_compared_value_while_a_returned_future_never_settles(executor):
    harness = Harness(executor, logger=Logger(executor.future))
    source = Watched(SOURCE)
    watched = weakref.ref(source)

    assert harness.get({"log_mismatches": True}, source=source) == CACHED
    del source
    gc.collect()

    assert len(harness.logger.warnings()) == 1
    assert harness.logging_events() == []
    assert watched() is None


def test_frees_the_capacity_slot_before_a_returned_future_settles(executor):
    harness = Harness(executor, logger=Logger(executor.future), shadow_max_in_flight=1)

    harness.get({"log_mismatches": True}, key="first")
    harness.get({"log_mismatches": True}, key="second")

    assert harness.outcomes("shadowValidation") == ["mismatch", "mismatch"]
    assert [details["cacheKey"] for details in harness.logger.warnings()] == [
        warning({}, key="first")["cacheKey"],
        warning({}, key="second")["cacheKey"],
    ]
    assert harness.logging_events() == []


def hook_unrenderable_side(cached, source):
    return [{"path": "/version", "cached": object()}]


@pytest.mark.parametrize(
    ("hook", "fields", "outcome"),
    [
        (raising_hook, {"mismatchPaths": None, "mismatchPathCount": None, "diffJson": None}, "hook_error"),
        (hook_unrenderable_side, {**PATH_FIELDS, "diffJson": None}, "render_error"),
    ],
    ids=["hook-raises", "hook-side-unrenderable"],
)
@pytest.mark.parametrize("logger", ["raises", "coroutine-fails", "pending"])
def test_records_the_earlier_failure_rather_than_logger_error(executor, hook, fields, outcome, logger):
    deliver = {"raises": logger_raises, "coroutine-fails": logger_coroutine_fails, "pending": executor.future}
    harness = Harness(executor, logger=Logger(deliver[logger]))

    assert harness.get({"mismatch_logging": {"diff": "values"}}, shadow_mismatch_diff=hook) == CACHED

    assert harness.logger.calls == [(MESSAGE, warning({**fields, "loggingOutcome": outcome}))]
    # Recorded at once, whatever the logger does, even while it is pending.
    assert harness.logging_events() == [logging_event(outcome)]


@pytest.mark.parametrize("bad", ["paths", {"path": "/version"}, 1])
def test_rejects_a_non_callable_shadow_mismatch_diff_where_each_api_captures_it(executor, bad):
    cache = DialCache()

    async def load():
        return SOURCE

    with pytest.raises(ConfigError, match="shadow_mismatch_diff must be callable"):
        cache.cached(
            key_type="user_id", cache_key=lambda: "123", use_case="Invalid", shadow_mismatch_diff=bad
        )(load)
    # The rejected registration leaves the use case free for a valid one.
    cache.cached(key_type="user_id", cache_key=lambda: "123", use_case="Invalid", shadow_mismatch_diff=None)(
        load
    )

    async def call():
        return await cache.get_or_load(
            lambda: SOURCE, key="123", key_type="user_id", use_case="InvalidInline", shadow_mismatch_diff=bad
        )

    with pytest.raises(ConfigError, match="shadow_mismatch_diff must be callable"):
        executor.finish(call())


def test_records_no_warning_and_one_config_resolution_for_an_invalid_runtime_shorthand(executor):
    harness = Harness(executor, provider=lambda key: {"shadow": {"logMismatches": "yes"}})

    harness.get({"log_mismatches": True})

    assert harness.outcomes("shadowValidation") == ["mismatch"]
    assert harness.config_errors() == [
        {"event": "error", **labels(), "layer": "remote", "error": "config_resolution", "inFallback": False}
    ]
    assert harness.logger.calls == []
    assert harness.logging_events() == []


@pytest.mark.parametrize(
    ("default", "runtime", "fields"),
    [
        ({"mismatch_logging": {"value": True}}, {"mismatchLogging": {"diff": "everything"}}, VALUE_FIELDS),
        (
            {"log_mismatches": True},
            {"logMismatches": "yes", "mismatchLogging": {"value": False, "diff": "paths"}},
            PATH_FIELDS,
        ),
        (
            {"log_mismatches": True},
            {"logMismatches": None, "mismatchLogging": {"value": "yes", "diff": "paths"}},
            PATH_FIELDS,
        ),
    ],
    ids=["invalid-leaf", "malformed-shorthand", "every-input-invalid-but-one"],
)
def test_records_one_config_resolution_per_admitted_job_and_logs_the_valid_leaves(
    executor, default, runtime, fields
):
    harness = Harness(executor, provider=lambda key: {"shadow": runtime})

    harness.get(default)

    assert len(harness.config_errors()) == 1
    assert harness.logger.warnings() == [warning(fields)]
    assert harness.logging_events() == [logging_event("logged")]


def test_records_no_config_resolution_for_a_job_dropped_before_admission(executor):
    gate = executor.future()
    harness = Harness(executor, provider=lambda key: {"shadow": {"logMismatches": "yes"}})
    policy = {"ttl_sec": {"remote": 60}, "ramp": {"remote": 0}, "shadow": {"ramp": 100}}

    async def call(key, load):
        with harness.cache.enable():
            return await harness.cache.get_or_load(
                load, key=key, key_type="user_id", use_case="Mismatch", default_config=policy
            )

    held = executor.task(call("held", lambda: gate))
    executor.drain()
    assert executor.finish(call("dropped", lambda: SOURCE)) == SOURCE
    assert harness.outcomes("shadowValidation") == ["dropped"]
    assert [event["useCase"] for event in harness.config_errors()] == ["Mismatch"]
    gate.set_result(SOURCE)
    executor.drain()
    assert held.result() == SOURCE
    assert len(harness.config_errors()) == 1


@pytest.mark.parametrize(
    ("default", "runtime", "fields"),
    [
        (
            {"log_mismatches": True, "mismatch_logging": {"value": False}},
            None,
            {**PATH_FIELDS, "diffJson": DIFF_JSON},
        ),
        ({"log_mismatches": False, "mismatch_logging": {"diff": "paths"}}, None, PATH_FIELDS),
        ({"mismatch_logging": {"diff": "paths"}}, {"log_mismatches": False}, None),
        ({"mismatch_logging": {"value": False}}, {"logMismatches": True}, EVERY_FIELD),
    ],
    ids=[
        "true-beside-value-false",
        "false-beside-paths",
        "runtime-false-over-paths",
        "runtime-true-over-value",
    ],
)
def test_logs_the_recorded_shorthand_table(executor, default, runtime, fields):
    provider = None if runtime is None else (lambda key: {"shadow": runtime})
    harness = Harness(executor, provider=provider)

    harness.get(default)

    assert harness.outcomes("shadowValidation") == ["mismatch"]
    assert harness.config_errors() == []
    if fields is None:
        assert harness.logger.calls == []
        assert harness.logging_events() == []
    else:
        assert harness.logger.warnings() == [warning(fields)]
        assert harness.logging_events() == [logging_event("logged")]


def test_disabled_overrides_every_inherited_mismatch_logging_leaf(executor):
    default = {"log_mismatches": True, "mismatch_logging": {"value": True, "diff": "values"}}
    disabled = Policy.disabled()
    assert disabled.shadow == {"ramp": 0, "mismatch_logging": {"value": False, "diff": "off"}}

    killed = Harness(executor, provider=lambda key: Policy.disabled())
    assert killed.get(default) == SOURCE
    assert killed.outcomes("shadowValidation") == []
    assert killed.logger.calls == []

    # With only the shadow ramp restored, the verdict still runs, but the
    # overlay's leaves replace both inherited ones.
    restored = Harness(executor, provider=lambda key: {"shadow": {**disabled.shadow, "ramp": 100}})
    restored.get(default)
    assert restored.outcomes("shadowValidation") == ["mismatch"]
    assert restored.logger.calls == []
    assert restored.logging_events() == []
    assert restored.config_errors() == []
