"""The built-in mismatch walk, its caps and rendering, and the shadow_mismatch_diff hook."""

from __future__ import annotations

import asyncio
import gc
import json
import math
import tracemalloc
import warnings
from pathlib import Path
from types import MappingProxyType

import pytest
from formal.schema import json_equal

from dialcache import UNDEFINED, _shadow_log
from dialcache._shadow_log import (
    KEY_MAX_BYTES,
    TRUNCATION_MARKER,
    VALUE_MAX_BYTES,
    MismatchLogPlan,
    clamp_utf8,
    diff_shadow_mismatch_json,
    render_json,
    render_shadow_mismatch_log,
)

VALUE_ONLY = MismatchLogPlan(value=True, diff="off")
PATHS_ONLY = MismatchLogPlan(value=False, diff="paths")
VALUES_ONLY = MismatchLogPlan(value=False, diff="values")
EVERYTHING = MismatchLogPlan(value=True, diff="values")

# The built-in walk's portable vectors (W10), read from the shared corpus every
# port replays; they also pin the examples docs/shadow-validation.md shows. An
# omitted cached or source member is an absent side (D13), UNDEFINED here.
PROTOCOL_VECTORS = Path(__file__).resolve().parents[2] / "formal/catalogs/protocol-vectors.json"
MISMATCH_PATH_VECTORS = json.loads(PROTOCOL_VECTORS.read_text(encoding="utf-8"))["mismatchPathVectors"]
PRESENT_MISMATCH_PATH_VECTORS = [
    vector for vector in MISMATCH_PATH_VECTORS if "cached" in vector and "source" in vector
]

CACHED_USER = {"id": "123", "email": "old@example.com"}
SOURCE_USER = {"id": "123", "email": "new@example.com"}
CACHED_USER_JSON = '{"id":"123","email":"old@example.com"}'
SOURCE_USER_JSON = '{"id":"123","email":"new@example.com"}'
FAILED_DIFF = {"mismatchPaths": None, "mismatchPathCount": None, "diffJson": None}


def circular():
    value = {}
    value["self"] = value
    return value


def nest_members(depth, leaf):
    value = leaf
    for _ in range(depth):
        value = {"n": value}
    return value


class Stateful(dict):
    """The native analog of a stateful toJSON: the encoder calls items() per rendering."""

    def __init__(self, email):
        # Non-empty: the encoder renders an empty dict without calling items().
        super().__init__(email=email)
        self.email = email
        self.renders = 0

    def items(self):
        self.renders += 1
        return [("email", self.email), ("render", self.renders)]


def assert_entries(actual, expected):
    assert json_equal(actual, expected), (actual, expected)
    # Each entry keeps the path, cached, source order diffJson renders.
    assert [list(entry) for entry in actual] == [list(entry) for entry in expected]


def test_renders_native_json_for_the_compared_values():
    assert clamp_utf8("urn:user_id:123#GetUser", KEY_MAX_BYTES) == "urn:user_id:123#GetUser"
    assert render_shadow_mismatch_log(
        VALUE_ONLY,
        {"id": "123", "name": "Zoë", "tags": ("a", "b")},
        {"id": "123", "name": "Zoë", "tags": ["a", "c"]},
    ) == (
        {
            "cachedValueJson": '{"id":"123","name":"Zoë","tags":["a","b"]}',
            "sourceValueJson": '{"id":"123","name":"Zoë","tags":["a","c"]}',
        },
        None,
    )


def test_escapes_lone_surrogates_as_ecmascript_json_does():
    assert render_json("\ud800") == '"\\ud800"'
    assert render_json({"\udfff": 1}) == '{"\\udfff":1}'
    fields, failure = render_shadow_mismatch_log(EVERYTHING, {"k": "\ud800"}, {"k": "x"})
    assert failure is None
    assert fields["cachedValueJson"] == '{"k":"\\ud800"}'
    assert fields["diffJson"] == '[{"path":"/k","cached":"\\ud800","source":"x"}]'


def test_nulls_each_unrenderable_side_independently():
    assert render_shadow_mismatch_log(VALUE_ONLY, circular(), {"version": 2}) == (
        {"cachedValueJson": None, "sourceValueJson": '{"version":2}'},
        "render_error",
    )
    assert render_shadow_mismatch_log(VALUE_ONLY, object(), UNDEFINED) == (
        {"cachedValueJson": None, "sourceValueJson": None},
        "render_error",
    )


def test_byte_clamps_keys_and_json_without_splitting_utf8():
    key = "k" * KEY_MAX_BYTES + "🙂"
    value = {"text": "🙂" * VALUE_MAX_BYTES}
    key_preview = clamp_utf8(key, KEY_MAX_BYTES)
    fields, failure = render_shadow_mismatch_log(VALUE_ONLY, value, value)
    preview = fields["cachedValueJson"]

    assert failure is None
    assert len(key_preview.encode()) <= KEY_MAX_BYTES
    assert len(preview.encode()) <= VALUE_MAX_BYTES
    assert key_preview.endswith(TRUNCATION_MARKER)
    assert preview.endswith(TRUNCATION_MARKER)
    assert "�" not in key_preview + preview
    assert fields["sourceValueJson"] == preview


@pytest.mark.parametrize("vector", PRESENT_MISMATCH_PATH_VECTORS, ids=lambda vector: vector["name"])
def test_computes_the_expected_entries(vector):
    entries, count = diff_shadow_mismatch_json(vector["cached"], vector["source"])
    assert_entries(entries, vector["entries"])
    assert count == vector["count"]


# An absent side reaches the walk only through rendering, as UNDEFINED.
@pytest.mark.parametrize("vector", MISMATCH_PATH_VECTORS, ids=lambda vector: vector["name"])
def test_renders_the_expected_diff_fields(vector):
    cached, source = vector.get("cached", UNDEFINED), vector.get("source", UNDEFINED)
    fields, failure = render_shadow_mismatch_log(VALUES_ONLY, cached, source)

    assert failure is None
    assert fields["mismatchPaths"] == [entry["path"] for entry in vector["entries"]]
    assert fields["mismatchPathCount"] == vector["count"]
    assert_entries(json.loads(fields["diffJson"]), vector["entries"])
    assert render_shadow_mismatch_log(PATHS_ONLY, cached, source) == (
        {"mismatchPaths": fields["mismatchPaths"], "mismatchPathCount": vector["count"]},
        None,
    )


@pytest.mark.parametrize(
    ("cached", "source", "entries"),
    [
        (True, 1, [{"path": "", "cached": True, "source": 1}]),
        (0, False, [{"path": "", "cached": 0, "source": False}]),
        (
            {"a": [True, 0]},
            {"a": [1, False]},
            [
                {"path": "/a/0", "cached": True, "source": 1},
                {"path": "/a/1", "cached": 0, "source": False},
            ],
        ),
        (None, False, [{"path": "", "cached": None, "source": False}]),
        ("1", 1, [{"path": "", "cached": "1", "source": 1}]),
        (1, 1.0, []),
        ({"n": -0.0}, {"n": 0}, []),
    ],
)
def test_compares_json_primitives_by_json_type(cached, source, entries):
    # Python's True == 1 and False == 0 must not hide a JSON difference.
    actual, count = diff_shadow_mismatch_json(cached, source)
    assert_entries(actual, entries)
    assert count == len(entries)


def test_compares_json_primitives_by_type_past_the_depth_cap():
    path = "/n" * 32
    entries, count = diff_shadow_mismatch_json(nest_members(34, True), nest_members(34, 1))
    assert_entries(entries, [{"path": path, "cached": nest_members(2, True), "source": nest_members(2, 1)}])
    assert count == 1
    assert diff_shadow_mismatch_json(nest_members(34, [1, None]), nest_members(34, [1.0, None])) == ([], 0)


def test_walks_members_named_like_javascript_prototype_members():
    cached = json.loads('{"constructor":1,"__proto__":{"a":1}}')
    source = json.loads('{"toString":"x","valueOf":null,"__proto__":{"a":2}}')
    entries = [
        {"path": "/__proto__/a", "cached": 1, "source": 2},
        {"path": "/constructor", "cached": 1},
        {"path": "/toString", "source": "x"},
        {"path": "/valueOf", "source": None},
    ]

    actual, count = diff_shadow_mismatch_json(cached, source)
    assert_entries(actual, entries)
    assert count == 4
    fields, failure = render_shadow_mismatch_log(VALUES_ONLY, cached, source)
    assert failure is None
    assert fields["mismatchPaths"] == [entry["path"] for entry in entries]
    assert_entries(json.loads(fields["diffJson"]), entries)


def test_compares_own_members_in_a_depth_capped_pair():
    def nest(leaf):
        return json.loads('{"a":' * 32 + leaf + "}" * 32)

    cached, source = nest('{"__proto__":{}}'), nest('{"b":{}}')
    entries = [{"path": "/a" * 32, "cached": {"__proto__": {}}, "source": {"b": {}}}]

    actual, count = diff_shadow_mismatch_json(cached, source)
    assert_entries(actual, entries)
    assert count == 1
    fields, failure = render_shadow_mismatch_log(VALUES_ONLY, cached, source)
    assert failure is None
    assert fields["mismatchPaths"] == ["/a" * 32]
    assert_entries(json.loads(fields["diffJson"]), entries)


def test_cuts_entries_at_64_in_walk_order_and_counts_every_difference():
    cached = {f"m{index:02d}": 0 for index in range(69, -1, -1)}
    source = {f"m{index:02d}": 1 for index in range(69, -1, -1)}
    entries = [{"path": f"/m{index:02d}", "cached": 0, "source": 1} for index in range(64)]

    actual, count = diff_shadow_mismatch_json(cached, source)
    assert_entries(actual, entries)
    assert count == 70
    assert render_shadow_mismatch_log(PATHS_ONLY, cached, source) == (
        {"mismatchPaths": [entry["path"] for entry in entries], "mismatchPathCount": 70},
        None,
    )


def test_clamps_each_pointer_to_512_bytes_without_splitting_utf8():
    cached = {"k" * 511: 1, "k" * 600: 1, "é" * 300: 1}
    source = {"k" * 511: 2, "k" * 600: 2, "é" * 300: 2}

    actual, count = diff_shadow_mismatch_json(cached, source)
    assert_entries(
        actual,
        [
            {"path": "/" + "k" * 511, "cached": 1, "source": 2},
            {"path": "/" + "k" * 497 + TRUNCATION_MARKER, "cached": 1, "source": 2},
            {"path": "/" + "é" * 248 + TRUNCATION_MARKER, "cached": 1, "source": 2},
        ],
    )
    assert count == 3


def test_never_builds_a_whole_pointer_under_a_deep_chain_of_long_names():
    # Copying the pointer prefix for each member would cost members times
    # pointer length; the walk builds only the clamped pointer of a retained entry.
    names = [f"{level:02d}" + "x" * 100_000 for level in range(31)]
    cached = {f"m{index:03d}": 0 for index in range(100)}
    source = {f"m{index:03d}": 1 for index in range(100)}
    for name in reversed(names):
        cached, source = {name: cached}, {name: source}
    path = "/" + names[0][:497] + TRUNCATION_MARKER

    tracemalloc.start()
    try:
        actual, count = diff_shadow_mismatch_json(cached, source)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()

    assert_entries(actual, [{"path": path, "cached": 0, "source": 1}] * 64)
    assert count == 100
    # A whole pointer here is 3.1 MB, and the prefixes along the chain 50 MB.
    assert peak < 1_000_000


def test_replaces_each_side_over_1_kib_with_its_clamped_json_text():
    numbers = [1000] * 300
    cached = {
        "accent": "é" * 600,
        "blob": "x" * 2000,
        "edge": "e" * 1022,
        "extra": "z" * 1100,
        "list": numbers,
    }
    source = {"accent": "a", "blob": "y", "edge": "f" * 1022, "list": [1000]}

    actual, count = diff_shadow_mismatch_json(cached, source)
    assert_entries(
        actual,
        [
            {"path": "/accent", "cached": '"' + "é" * 504 + TRUNCATION_MARKER, "source": "a"},
            {"path": "/blob", "cached": '"' + "x" * 1009 + TRUNCATION_MARKER, "source": "y"},
            {"path": "/edge", "cached": "e" * 1022, "source": "f" * 1022},
            {"path": "/extra", "cached": '"' + "z" * 1009 + TRUNCATION_MARKER},
            {
                "path": "/list",
                "cached": json.dumps(numbers, separators=(",", ":"))[:1010] + TRUNCATION_MARKER,
                "source": [1000],
            },
        ],
    )
    assert count == 5


def test_caps_the_walk_at_32_reference_tokens_however_deep_the_difference_lies():
    actual, count = diff_shadow_mismatch_json(nest_members(40, 1), nest_members(40, 2))
    assert_entries(actual, [{"path": "/n" * 32, "cached": nest_members(8, 1), "source": nest_members(8, 2)}])
    assert count == 1
    clamped = '{"n":' * 202 + TRUNCATION_MARKER
    actual, count = diff_shadow_mismatch_json(nest_members(300, 1), nest_members(300, 2))
    assert_entries(actual, [{"path": "/n" * 32, "cached": clamped, "source": clamped}])
    assert count == 1


def test_compares_equal_containers_past_the_depth_cap_regardless_of_order_and_depth():
    cached, source = "leaf", "leaf"
    for level in range(100_000):
        cached = {"a": level, "next": cached}
        source = {"next": source, "a": level}

    assert diff_shadow_mismatch_json(cached, source) == ([], 0)


@pytest.mark.parametrize(
    ("plan", "fields"),
    [
        (MismatchLogPlan(False, "off"), {}),
        (PATHS_ONLY, {"mismatchPaths": ["/email"], "mismatchPathCount": 1}),
        (
            VALUES_ONLY,
            {
                "mismatchPaths": ["/email"],
                "mismatchPathCount": 1,
                "diffJson": '[{"path":"/email","cached":"old@example.com","source":"new@example.com"}]',
            },
        ),
        (VALUE_ONLY, {"cachedValueJson": CACHED_USER_JSON, "sourceValueJson": SOURCE_USER_JSON}),
        (
            MismatchLogPlan(True, "paths"),
            {
                "mismatchPaths": ["/email"],
                "mismatchPathCount": 1,
                "cachedValueJson": CACHED_USER_JSON,
                "sourceValueJson": SOURCE_USER_JSON,
            },
        ),
        (
            EVERYTHING,
            {
                "mismatchPaths": ["/email"],
                "mismatchPathCount": 1,
                "diffJson": '[{"path":"/email","cached":"old@example.com","source":"new@example.com"}]',
                "cachedValueJson": CACHED_USER_JSON,
                "sourceValueJson": SOURCE_USER_JSON,
            },
        ),
    ],
    ids=["neither", "paths", "values", "value", "value-paths", "value-values"],
)
def test_renders_exactly_the_requested_fields(plan, fields):
    content = render_shadow_mismatch_log(plan, CACHED_USER, SOURCE_USER)

    assert content == (fields, None)
    assert list(content[0]) == list(fields)


def test_renders_no_entries_when_the_renderings_hold_the_same_json():
    no_entries = {"mismatchPaths": [], "mismatchPathCount": 0, "diffJson": "[]"}

    # The default comparator tells a tuple from a list; both render as arrays.
    assert render_shadow_mismatch_log(EVERYTHING, {"tags": ("a",)}, {"tags": ["a"]}) == (
        {**no_entries, "cachedValueJson": '{"tags":["a"]}', "sourceValueJson": '{"tags":["a"]}'},
        None,
    )
    # Different text, same JSON values.
    assert render_shadow_mismatch_log(VALUES_ONLY, {"n": 1.0, "m": 2}, {"m": 2, "n": 1}) == (no_entries, None)


@pytest.mark.parametrize(
    "unrenderable",
    [circular(), object(), {1, 2}, math.nan, math.inf, {"nested": UNDEFINED}, b"bytes"],
    ids=["cycle", "object", "set", "nan", "inf", "nested-undefined", "bytes"],
)
def test_nulls_the_fields_fed_by_an_unrenderable_root_with_render_error(unrenderable):
    assert render_shadow_mismatch_log(EVERYTHING, unrenderable, {"version": 2}) == (
        {**FAILED_DIFF, "cachedValueJson": None, "sourceValueJson": '{"version":2}'},
        "render_error",
    )
    assert render_shadow_mismatch_log(EVERYTHING, {"version": 2}, unrenderable) == (
        {**FAILED_DIFF, "cachedValueJson": '{"version":2}', "sourceValueJson": None},
        "render_error",
    )
    assert render_shadow_mismatch_log(PATHS_ONLY, {"version": 2}, unrenderable) == (
        {"mismatchPaths": None, "mismatchPathCount": None},
        "render_error",
    )


def test_reports_an_absent_root_as_one_side_at_the_root_pointer():
    assert render_shadow_mismatch_log(EVERYTHING, UNDEFINED, {"version": 2}) == (
        {
            "mismatchPaths": [""],
            "mismatchPathCount": 1,
            "diffJson": '[{"path":"","source":{"version":2}}]',
            "cachedValueJson": None,
            "sourceValueJson": '{"version":2}',
        },
        None,
    )
    assert render_shadow_mismatch_log(EVERYTHING, {"version": 2}, UNDEFINED) == (
        {
            "mismatchPaths": [""],
            "mismatchPathCount": 1,
            "diffJson": '[{"path":"","cached":{"version":2}}]',
            "cachedValueJson": '{"version":2}',
            "sourceValueJson": None,
        },
        None,
    )
    assert render_shadow_mismatch_log(PATHS_ONLY, UNDEFINED, None) == (
        {"mismatchPaths": [""], "mismatchPathCount": 1},
        None,
    )
    # A stored None is a value, so it stays distinct from absence.
    fields, _ = render_shadow_mismatch_log(VALUES_ONLY, UNDEFINED, None)
    assert fields["diffJson"] == '[{"path":"","source":null}]'
    # Absence beside a side with no rendering is still a render failure.
    assert render_shadow_mismatch_log(EVERYTHING, UNDEFINED, object()) == (
        {**FAILED_DIFF, "cachedValueJson": None, "sourceValueJson": None},
        "render_error",
    )
    # A custom comparator may call two absent values different; no field differs.
    assert render_shadow_mismatch_log(EVERYTHING, UNDEFINED, UNDEFINED) == (
        {
            "mismatchPaths": [],
            "mismatchPathCount": 0,
            "diffJson": "[]",
            "cachedValueJson": None,
            "sourceValueJson": None,
        },
        None,
    )


def test_renders_each_side_once_for_every_field_it_feeds():
    cached, source = Stateful("a"), Stateful("b")

    assert render_shadow_mismatch_log(EVERYTHING, cached, source) == (
        {
            "mismatchPaths": ["/email"],
            "mismatchPathCount": 1,
            "diffJson": '[{"path":"/email","cached":"a","source":"b"}]',
            "cachedValueJson": '{"email":"a","render":1}',
            "sourceValueJson": '{"email":"b","render":1}',
        },
        None,
    )
    assert (cached.renders, source.renders) == (1, 1)


def test_clamps_diff_json_to_8_kib_with_the_truncation_marker():
    cached = {f"m{index:02d}": "x" * 500 for index in range(20)}
    source = {f"m{index:02d}": "y" * 500 for index in range(20)}
    entries = [{"path": f"/m{index:02d}", "cached": "x" * 500, "source": "y" * 500} for index in range(20)]
    # The 8 KiB bound is the record's, so it is written out rather than taken
    # from the implementation's constant.
    diff_json = (
        json.dumps(entries, separators=(",", ":"))[: 8192 - len(TRUNCATION_MARKER)] + TRUNCATION_MARKER
    )

    assert render_shadow_mismatch_log(VALUES_ONLY, cached, source) == (
        {
            "mismatchPaths": [entry["path"] for entry in entries],
            "mismatchPathCount": 20,
            "diffJson": diff_json,
        },
        None,
    )
    assert len(diff_json.encode()) == 8192


def test_clamps_each_built_in_diff_json_side_to_1_kib():
    fields, _ = render_shadow_mismatch_log(VALUES_ONLY, {"blob": "x" * 2000}, {"blob": "y"})

    assert json.loads(fields["diffJson"]) == [
        {"path": "/blob", "cached": '"' + "x" * 1009 + TRUNCATION_MARKER, "source": "y"}
    ]


@pytest.mark.parametrize("error", [RuntimeError("walk failed"), RecursionError("too deep")])
def test_fails_the_built_in_walk_closed_with_hook_error(monkeypatch, error):
    def walk(cached, source):
        raise error

    monkeypatch.setattr(_shadow_log, "_walk", walk)
    assert render_shadow_mismatch_log(EVERYTHING, CACHED_USER, SOURCE_USER) == (
        {**FAILED_DIFF, "cachedValueJson": CACHED_USER_JSON, "sourceValueJson": SOURCE_USER_JSON},
        "hook_error",
    )
    assert render_shadow_mismatch_log(PATHS_ONLY, CACHED_USER, SOURCE_USER) == (
        {"mismatchPaths": None, "mismatchPathCount": None},
        "hook_error",
    )


def test_takes_the_entries_from_the_hook_and_never_runs_the_built_in_walk(monkeypatch):
    cached, source = {"id": 1}, {"id": 2}
    calls = []

    def hook(*args):
        calls.append(args)
        return [
            {"path": "/profile/email", "cached": "old@example.com", "source": "new@example.com"},
            MappingProxyType({"path": "/roles"}),
        ]

    def walk(cached, source):
        raise AssertionError("the built-in walk ran")

    monkeypatch.setattr(_shadow_log, "_walk", walk)
    assert render_shadow_mismatch_log(EVERYTHING, cached, source, hook) == (
        {
            "mismatchPaths": ["/profile/email", "/roles"],
            "mismatchPathCount": 2,
            "diffJson": '[{"path":"/profile/email","cached":"old@example.com","source":"new@example.com"},'
            '{"path":"/roles"}]',
            "cachedValueJson": '{"id":1}',
            "sourceValueJson": '{"id":2}',
        },
        None,
    )
    assert len(calls) == 1
    assert calls[0][0] is cached and calls[0][1] is source


def test_renders_neither_root_side_when_the_hook_supplies_entries_and_value_is_off():
    cached, source = Stateful("a"), Stateful("b")

    assert render_shadow_mismatch_log(VALUES_ONLY, cached, source, lambda cached, source: []) == (
        {"mismatchPaths": [], "mismatchPathCount": 0, "diffJson": "[]"},
        None,
    )
    assert (cached.renders, source.renders) == (0, 0)


class FailingSide(dict):
    def __getitem__(self, name):
        if name == "cached":
            raise RuntimeError("side unavailable")
        return super().__getitem__(name)


def raises(cached, source):
    raise RuntimeError("hook failed")


def cancels(cached, source):
    raise asyncio.CancelledError()


async def coroutine_hook(cached, source):
    return [{"path": "/email"}]


@pytest.mark.parametrize(
    "hook",
    [
        raises,
        cancels,
        coroutine_hook,
        lambda cached, source: {"path": "/email"},
        lambda cached, source: None,
        lambda cached, source: ({"path": "/email"},),
        lambda cached, source: lambda: [],
        lambda cached, source: [None],
        lambda cached, source: ["/email"],
        lambda cached, source: [lambda: "/email"],
        lambda cached, source: [{"cached": 1}],
        lambda cached, source: [{"path": 0}],
        lambda cached, source: [{"path": b"/email"}],
        lambda cached, source: [{"path": "/email"}, {"path": None}],
        lambda cached, source: [*({"path": f"/{index}"} for index in range(64)), None],
        lambda cached, source: [*({"path": f"/{index}"} for index in range(64)), {"path": None}],
        lambda cached, source: [FailingSide(path="/email", cached=1)],
    ],
    ids=[
        "raises",
        "raises-cancelled",
        "coroutine",
        "non-list-mapping",
        "none",
        "tuple",
        "callable",
        "none-member",
        "string-member",
        "callable-member",
        "member-without-path",
        "numeric-path",
        "bytes-path",
        "invalid-after-valid",
        "invalid-past-the-cut",
        "invalid-path-past-the-cut",
        "failing-side",
    ],
)
def test_fails_closed_with_hook_error_and_no_fallback(hook):
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        assert render_shadow_mismatch_log(EVERYTHING, CACHED_USER, SOURCE_USER, hook) == (
            {**FAILED_DIFF, "cachedValueJson": CACHED_USER_JSON, "sourceValueJson": SOURCE_USER_JSON},
            "hook_error",
        )
        assert render_shadow_mismatch_log(PATHS_ONLY, CACHED_USER, SOURCE_USER, hook) == (
            {"mismatchPaths": None, "mismatchPathCount": None},
            "hook_error",
        )
        gc.collect()


def test_closes_a_coroutine_hook_result_without_running_it():
    started, returned = [], []

    async def work():
        started.append(True)
        return []

    def hook(cached, source):
        returned.append(work())
        return returned[-1]

    assert render_shadow_mismatch_log(PATHS_ONLY, CACHED_USER, SOURCE_USER, hook)[1] == "hook_error"
    assert started == []
    assert returned[0].cr_frame is None


def test_consumes_a_failing_future_hook_result_without_owning_it():
    loop = asyncio.new_event_loop()
    unretrieved = []
    loop.set_exception_handler(lambda loop, context: unretrieved.append(context))
    try:
        returned = [loop.create_future()]
        assert render_shadow_mismatch_log(PATHS_ONLY, CACHED_USER, SOURCE_USER, lambda c, s: returned[0])[
            1
        ] == ("hook_error")
        future = returned.pop()
        assert not future.done()
        future.set_exception(RuntimeError("hook task failed"))
        loop.run_until_complete(asyncio.sleep(0))
        del future
        gc.collect()
    finally:
        loop.close()
    assert unretrieved == []


@pytest.mark.parametrize(
    "unrenderable",
    [object(), circular(), math.nan, {1}],
    ids=["object", "cycle", "nan", "set"],
)
def test_keeps_the_hook_paths_and_nulls_diff_json_when_a_hook_side_has_no_rendering(unrenderable):
    def hook(cached, source):
        return [{"path": "/a", "cached": 1}, {"path": "/b", "source": unrenderable}]

    assert render_shadow_mismatch_log(VALUES_ONLY, CACHED_USER, SOURCE_USER, hook) == (
        {"mismatchPaths": ["/a", "/b"], "mismatchPathCount": 2, "diffJson": None},
        "render_error",
    )
    assert render_shadow_mismatch_log(PATHS_ONLY, CACHED_USER, SOURCE_USER, hook) == (
        {"mismatchPaths": ["/a", "/b"], "mismatchPathCount": 2},
        None,
    )


def test_stops_rendering_hook_sides_at_the_first_side_with_no_rendering():
    later = Stateful("later")

    def hook(cached, source):
        return [{"path": "/a", "cached": object()}, {"path": "/b", "source": later}]

    assert render_shadow_mismatch_log(VALUES_ONLY, CACHED_USER, SOURCE_USER, hook) == (
        {"mismatchPaths": ["/a", "/b"], "mismatchPathCount": 2, "diffJson": None},
        "render_error",
    )
    assert later.renders == 0


def test_omits_absent_hook_sides_from_diff_json_and_renders_present_ones_as_json():
    def hook(cached, source):
        return [
            {"path": "/a"},
            {"path": "/b", "cached": 1},
            {"path": "/c", "source": None},
            {"path": "/d", "cached": UNDEFINED, "source": "x"},
            {"path": "/t", "cached": ("a",), "source": {"ok": True}},
        ]

    fields, failure = render_shadow_mismatch_log(VALUES_ONLY, CACHED_USER, SOURCE_USER, hook)
    assert failure is None
    assert fields["diffJson"] == (
        '[{"path":"/a"},{"path":"/b","cached":1},{"path":"/c","source":null},{"path":"/d","source":"x"},'
        '{"path":"/t","cached":["a"],"source":{"ok":true}}]'
    )


def test_clamps_hook_paths_and_sides_and_cuts_at_64_with_the_total_count():
    long_path = "/" + "k" * 600
    clamped_path = "/" + "k" * 497 + TRUNCATION_MARKER

    def hook(cached, source):
        return [
            {"path": long_path, "cached": "x" * 2000, "source": {"ok": True}},
            *({"path": f"/{index + 1}"} for index in range(69)),
        ]

    retained = [f"/{index + 1}" for index in range(63)]
    fields, failure = render_shadow_mismatch_log(VALUES_ONLY, CACHED_USER, SOURCE_USER, hook)

    assert failure is None
    assert fields["mismatchPaths"] == [clamped_path, *retained]
    assert fields["mismatchPathCount"] == 70
    assert json.loads(fields["diffJson"]) == [
        {"path": clamped_path, "cached": '"' + "x" * 1009 + TRUNCATION_MARKER, "source": {"ok": True}},
        *({"path": path} for path in retained),
    ]


def test_does_not_call_the_hook_when_diff_is_off():
    calls = []

    def hook(cached, source):
        calls.append(True)
        return [{"path": "/email"}]

    assert render_shadow_mismatch_log(VALUE_ONLY, CACHED_USER, SOURCE_USER, hook) == (
        {"cachedValueJson": CACHED_USER_JSON, "sourceValueJson": SOURCE_USER_JSON},
        None,
    )
    assert calls == []


def test_keeps_the_hook_entries_when_a_root_side_has_no_rendering():
    assert render_shadow_mismatch_log(EVERYTHING, object(), SOURCE_USER, lambda c, s: [{"path": "/a"}]) == (
        {
            "mismatchPaths": ["/a"],
            "mismatchPathCount": 1,
            "diffJson": '[{"path":"/a"}]',
            "cachedValueJson": None,
            "sourceValueJson": SOURCE_USER_JSON,
        },
        "render_error",
    )


def test_reports_hook_error_ahead_of_render_error():
    assert render_shadow_mismatch_log(EVERYTHING, circular(), SOURCE_USER, raises) == (
        {**FAILED_DIFF, "cachedValueJson": None, "sourceValueJson": SOURCE_USER_JSON},
        "hook_error",
    )
