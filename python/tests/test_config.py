import math

import pytest

from dialcache.config import (
    MAX_CACHE_TTL_SEC,
    MAX_TIMER_DELAY_MS,
    UNSET,
    MismatchLogging,
    Policy,
    deterministic_ramp_sample,
    expand_mismatch_logging,
    merge_policy,
    normalize_policy,
    resolve_layer,
    resolve_mismatch_logging,
    validate_deadline_ms,
    validate_static_policy,
)
from dialcache.errors import ConfigError


def test_sparse_merge_snapshots_every_leaf_and_inherits_provider_none():
    ttl = {"local": 10, "remote": 60}
    defaults = Policy(
        ttl_sec=ttl,
        ramp={"local": 50},
        request_local=True,
        coalesce=False,
        remote_read_timeout_ms=75,
        shadow={"ramp": 20, "log_mismatches": True},
        stale_on_error_max_age_sec=120,
    )
    ttl["local"] = 500
    merged = merge_policy(defaults, {"ttlSec": {"remote": 30}, "shadow": {"ramp": 0}})
    assert merged.ttl_sec == {"local": 10, "remote": 30}
    assert merged.ramp == {"local": 50}
    assert merged.request_local is True
    assert merged.coalesce is False
    assert merged.remote_read_timeout_ms == 75
    assert merged.stale_on_error_max_age_sec == 120
    # The default shorthand expands before the merge, so only leaves remain.
    assert merged.shadow == {"ramp": 0, "mismatch_logging": {"value": True, "diff": "values"}}
    assert merge_policy(defaults, None) is defaults
    assert merge_policy(None, None) is None
    with pytest.raises(TypeError):
        merged.ttl_sec["local"] = 100


@pytest.mark.parametrize("field", ["requestLocal", "coalesce", "remoteReadTimeoutMs"])
@pytest.mark.parametrize("value", [None, "false", [], True])
def test_malformed_flags_and_budget_fail_resolution(field, value):
    if field != "remoteReadTimeoutMs" and value is True:
        return
    with pytest.raises(ConfigError):
        merge_policy(Policy(request_local=True), {field: value})


@pytest.mark.parametrize("bad", [None, [], 5, "policy"])
@pytest.mark.parametrize("field", ["ttlSec", "ramp", "shadow"])
def test_malformed_containers_fail_resolution(field, bad):
    with pytest.raises(ConfigError):
        normalize_policy({field: bad})


@pytest.mark.parametrize(
    "bad", [None, False, 0, -1, 1.5, math.inf, math.nan, MAX_CACHE_TTL_SEC + 1, 10**1000]
)
def test_invalid_ttl_disables_only_affected_layer(bad):
    policy = merge_policy(Policy.enabled(10), {"ttl_sec": {"local": bad}})
    assert resolve_layer(policy, "urn:user:a:case", "local").reason == "invalid_ttl"
    assert resolve_layer(policy, "urn:user:a:case", "remote").enabled
    with pytest.raises(ConfigError):
        validate_static_policy(policy)


@pytest.mark.parametrize("bad", [None, True, -1, 101, math.inf, math.nan, "50", 10**1000])
def test_invalid_ramp_disables_only_affected_layer(bad):
    policy = merge_policy(Policy.enabled(10), {"ramp": {"remote": bad}})
    assert resolve_layer(policy, "urn:user:a:case", "remote").reason == "invalid_ramp"
    assert resolve_layer(policy, "urn:user:a:case", "local").enabled


def test_ramp_is_strict_stable_and_utf16_compatible():
    urn = "urn:user:\U0001f600:case"
    sample = deterministic_ramp_sample(urn, "remote")
    # Computed independently with JavaScript UTF-16 FNV-1a.
    assert sample == 8.489463897421956
    assert (
        resolve_layer(Policy(ttl_sec={"remote": 1}, ramp={"remote": sample - 0.001}), urn, "remote").reason
        == "ramped_down"
    )
    assert (
        resolve_layer(Policy(ttl_sec={"remote": 1}, ramp={"remote": sample}), urn, "remote").reason
        == "ramped_down"
    )
    assert resolve_layer(
        Policy(ttl_sec={"remote": 1}, ramp={"remote": sample + 0.001}), urn, "remote"
    ).enabled


def test_disabled_overlay_turns_off_all_inherited_paths():
    default = Policy(
        ttl_sec={"local": 10, "remote": 10},
        request_local=True,
        stale_on_error_max_age_sec=20,
        shadow={"ramp": 100, "log_mismatches": True},
    )
    merged = merge_policy(default, Policy.disabled())
    assert merged.request_local is False
    assert merged.stale_on_error_max_age_sec == 0
    assert merged.shadow == {"ramp": 0, "mismatch_logging": {"value": False, "diff": "off"}}
    assert resolve_mismatch_logging(merged.shadow) == MismatchLogging(False, "off", False)
    assert merged.coalesce is UNSET
    assert resolve_layer(merged, "key", "local").reason == "ramped_down"
    assert resolve_layer(merged, "key", "remote").reason == "ramped_down"


@pytest.mark.parametrize("age", [None, False, 1, 10, 1.5, MAX_CACHE_TTL_SEC + 1, "20"])
def test_bad_optional_recovery_keeps_remote_serving(age):
    resolved = resolve_layer(Policy(ttl_sec={"remote": 10}, stale_on_error_max_age_sec=age), "key", "remote")
    assert resolved.enabled
    assert resolved.stale_on_error_config_error
    assert resolved.stale_on_error_max_age_sec is None


def test_recovery_requires_remote_and_strictly_larger_positive_age():
    assert resolve_layer(Policy(stale_on_error_max_age_sec=20), "key", "remote").stale_on_error_config_error
    resolved = resolve_layer(Policy(ttl_sec={"remote": 10}, stale_on_error_max_age_sec=11), "key", "remote")
    assert resolved.stale_on_error_max_age_sec == 11
    assert not resolved.stale_on_error_config_error
    assert not resolve_layer(
        Policy(stale_on_error_max_age_sec=0), "key", "remote"
    ).stale_on_error_config_error


@pytest.mark.parametrize("value", [True, False, None, 0, -1, 0.5, MAX_TIMER_DELAY_MS + 1, 10**1000])
def test_deadlines_reject_unsupported_domain(value):
    with pytest.raises(ConfigError):
        validate_deadline_ms(value)


def test_deadline_and_ttl_boundaries_are_inclusive():
    assert validate_deadline_ms(1) == 1
    assert validate_deadline_ms(MAX_TIMER_DELAY_MS) == MAX_TIMER_DELAY_MS
    policy = validate_static_policy(Policy.enabled(MAX_CACHE_TTL_SEC))
    assert resolve_layer(policy, "key", "local").ttl_sec == MAX_CACHE_TTL_SEC


ABSENT = object()


def shadow_layer(shorthand, group, camel=False):
    """One shadow group with each field omitted (ABSENT) or written."""
    shadow = {}
    if shorthand is not ABSENT:
        shadow["logMismatches" if camel else "log_mismatches"] = shorthand
    if group is not ABSENT:
        shadow["mismatchLogging" if camel else "mismatch_logging"] = group
    return shadow


def expected_leaves(default, runtime):
    """The recorded rule, written out without the code under test.

    A written shorthand stands for both leaves (True: value on and diff
    "values"; False or malformed: both off), a leaf written beside it wins
    within its own layer, the runtime layer wins per leaf, an omitted leaf is
    off, an invalid leaf acts off, and an invalid input owes one
    config_resolution. Defaults stay valid, as static validation guarantees.
    """

    def leaves(shorthand, group):
        result = {}
        if shorthand is not ABSENT:
            result = {"value": shorthand is True, "diff": "values" if shorthand is True else "off"}
        if group is not ABSENT:
            result.update({leaf: group[leaf] for leaf in ("value", "diff") if leaf in group})
        return result

    inherited, written = leaves(*default), leaves(*runtime)
    value = written["value"] if "value" in written else inherited.get("value", ABSENT)
    diff = written["diff"] if "diff" in written else inherited.get("diff", ABSENT)
    valid_value = value is ABSENT or isinstance(value, bool)
    valid_diff = diff is ABSENT or (isinstance(diff, str) and diff in ("off", "paths", "values"))
    malformed = runtime[0] is not ABSENT and not isinstance(runtime[0], bool)
    return MismatchLogging(
        value=valid_value and value is True,
        diff=diff if valid_diff and diff is not ABSENT else "off",
        invalid=malformed or not valid_value or not valid_diff,
    )


def test_merge_expands_each_layer_before_leaves_merge_for_every_combination():
    default_shorthands = [ABSENT, True, False]
    default_groups = [
        ABSENT,
        {},
        {"value": True},
        {"value": False},
        {"diff": "paths"},
        {"diff": "off"},
        {"value": True, "diff": "values"},
    ]
    runtime_shorthands = [ABSENT, True, False, "yes", None, 0, 1]
    runtime_groups = [
        ABSENT,
        {"value": True},
        {"value": False},
        {"diff": "paths"},
        {"diff": "values"},
        {"value": True, "diff": "off"},
        {"value": "yes"},
        {"value": None},
        {"diff": "full"},
        {"diff": "toString"},
        {"diff": None},
        {"unknown": True},
    ]
    combinations = 0
    for default_shorthand in default_shorthands:
        for default_group in default_groups:
            default = validate_static_policy(Policy(shadow=shadow_layer(default_shorthand, default_group)))
            for runtime_shorthand in runtime_shorthands:
                for runtime_group in runtime_groups:
                    expected = expected_leaves(
                        (default_shorthand, default_group), (runtime_shorthand, runtime_group)
                    )
                    for camel in (False, True):
                        runtime = {"shadow": shadow_layer(runtime_shorthand, runtime_group, camel)}
                        merged = merge_policy(default, runtime)
                        assert resolve_mismatch_logging(merged.shadow) == expected, (
                            default.shadow,
                            runtime,
                        )
                        combinations += 1
    assert combinations == 3 * 7 * 7 * 12 * 2

    # disabled() on either side, and a runtime policy without a shadow group.
    disabled = Policy.disabled().shadow
    for default, runtime, expected in [
        ({"log_mismatches": True}, Policy.disabled(), MismatchLogging(False, "off", False)),
        (
            disabled,
            {"shadow": {"mismatchLogging": {"diff": "paths"}}},
            MismatchLogging(False, "paths", False),
        ),
        (
            {"log_mismatches": True, "mismatch_logging": {"diff": "paths"}},
            {"ttl_sec": {}},
            MismatchLogging(True, "paths", False),
        ),
    ]:
        merged = merge_policy(Policy(shadow=default), runtime)
        assert resolve_mismatch_logging(merged.shadow) == expected


@pytest.mark.parametrize(
    ("default", "runtime", "effective"),
    [
        (None, {"log_mismatches": True, "mismatch_logging": {"value": False}}, (False, "values")),
        ({"log_mismatches": True, "mismatch_logging": {"value": False}}, None, (False, "values")),
        (None, {"log_mismatches": False, "mismatch_logging": {"diff": "paths"}}, (False, "paths")),
        ({"log_mismatches": False, "mismatch_logging": {"diff": "paths"}}, None, (False, "paths")),
        ({"mismatch_logging": {"diff": "paths"}}, {"log_mismatches": False}, (False, "off")),
        ({"mismatch_logging": {"value": False}}, {"log_mismatches": True}, (True, "values")),
    ],
)
@pytest.mark.parametrize("provider_none", [False, True])
def test_recorded_shorthand_table(default, runtime, effective, provider_none):
    defaults = validate_static_policy(Policy(shadow=default) if default is not None else Policy())
    if provider_none and runtime is not None:
        return
    merged = merge_policy(defaults, None if provider_none else {"shadow": runtime or {}})
    assert resolve_mismatch_logging(merged.shadow) == MismatchLogging(*effective, False)


def test_runtime_leaves_inherit_and_override_default_leaves():
    merged = merge_policy(
        Policy(shadow={"mismatch_logging": {"value": True, "diff": "paths"}}),
        {"shadow": {"mismatch_logging": {"diff": "values"}}},
    )
    assert merged.shadow == {"mismatch_logging": {"value": True, "diff": "values"}}
    merged = merge_policy(
        Policy(shadow={"mismatch_logging": {"value": True, "diff": "values"}}),
        {"shadow": {"mismatch_logging": {"value": False}}},
    )
    assert merged.shadow == {"mismatch_logging": {"value": False, "diff": "values"}}
    # A default shorthand is a baseline like any other pair of default leaves.
    merged = merge_policy(
        Policy(shadow={"log_mismatches": True}), {"shadow": {"mismatchLogging": {"diff": "paths"}}}
    )
    assert merged.shadow == {"mismatch_logging": {"value": True, "diff": "paths"}}
    # A runtime shorthand replaces both inherited leaves.
    merged = merge_policy(
        Policy(shadow={"ramp": 5, "mismatch_logging": {"value": True, "diff": "paths"}}),
        {"shadow": {"log_mismatches": False}},
    )
    assert merged.shadow == {"ramp": 5, "mismatch_logging": {"value": False, "diff": "off"}}


def test_merge_keeps_a_malformed_runtime_shorthand_for_admission():
    merged = merge_policy(
        Policy(shadow={"mismatch_logging": {"value": False, "diff": "values"}}),
        {"shadow": {"logMismatches": "yes", "mismatchLogging": {"value": True}}},
    )
    # The malformed shorthand expands to both leaves off over the default, the
    # leaf written beside it still wins, and the raw value stays so admission
    # records its config_resolution.
    assert merged.shadow == {"log_mismatches": "yes", "mismatch_logging": {"value": True, "diff": "off"}}
    assert resolve_mismatch_logging(merged.shadow) == MismatchLogging(True, "off", True)


@pytest.mark.parametrize(
    ("shadow", "expected"),
    [
        ({}, (False, "off", False)),
        ({"mismatch_logging": {}}, (False, "off", False)),
        ({"mismatch_logging": {"value": True, "diff": "paths"}}, (True, "paths", False)),
        ({"mismatch_logging": {"value": "true", "diff": "paths"}}, (False, "paths", True)),
        ({"mismatch_logging": {"value": None}}, (False, "off", True)),
        ({"mismatch_logging": {"value": 1}}, (False, "off", True)),
        ({"mismatch_logging": {"value": True, "diff": "full"}}, (True, "off", True)),
        ({"mismatch_logging": {"diff": 1}}, (False, "off", True)),
        ({"mismatch_logging": {"diff": None}}, (False, "off", True)),
        ({"mismatch_logging": {"diff": ["paths"]}}, (False, "off", True)),
        ({"mismatch_logging": {"value": True, "diff": "__class__"}}, (True, "off", True)),
        ({"log_mismatches": "yes"}, (False, "off", True)),
        ({"log_mismatches": None}, (False, "off", True)),
        ({"log_mismatches": 1}, (False, "off", True)),
        (
            {"log_mismatches": "yes", "mismatch_logging": {"value": True, "diff": "values"}},
            (True, "values", True),
        ),
    ],
)
def test_resolves_each_leaf_independently(shadow, expected):
    assert resolve_mismatch_logging(shadow) == MismatchLogging(*expected)


def test_expands_the_shorthand_before_the_same_group_leaves():
    assert expand_mismatch_logging({}) == {}
    assert expand_mismatch_logging({"log_mismatches": True}) == {"value": True, "diff": "values"}
    assert expand_mismatch_logging({"log_mismatches": False}) == {"value": False, "diff": "off"}
    assert expand_mismatch_logging({"log_mismatches": "yes"}) == {
        "value": False,
        "diff": "off",
        "invalid": True,
    }
    assert expand_mismatch_logging({"log_mismatches": True, "mismatch_logging": {"value": False}}) == {
        "value": False,
        "diff": "values",
    }
    assert expand_mismatch_logging(
        {"log_mismatches": "yes", "mismatch_logging": {"value": True, "diff": "paths"}}
    ) == {"value": True, "diff": "paths", "invalid": True}
    # Written leaves pass through unvalidated: resolution owns their validation.
    assert expand_mismatch_logging({"mismatch_logging": {"diff": "full"}}) == {"diff": "full"}


@pytest.mark.parametrize("bad", [None, [], 1, "paths"])
@pytest.mark.parametrize("name", ["mismatch_logging", "mismatchLogging"])
def test_non_object_mismatch_logging_fails_resolution(name, bad):
    with pytest.raises(ConfigError, match="mismatch_logging must be an object"):
        Policy(shadow={name: bad})
    with pytest.raises(ConfigError, match="mismatch_logging must be an object"):
        merge_policy(Policy.enabled(10), {"shadow": {name: bad}})


def test_mismatch_logging_snapshots_known_leaves_and_accepts_camel_case():
    group = {"value": True, "diff": "paths", "key": True}
    policy = Policy(shadow={"logMismatches": False, "mismatchLogging": group})
    group["diff"] = "values"
    assert policy.shadow == {"log_mismatches": False, "mismatch_logging": {"value": True, "diff": "paths"}}
    with pytest.raises(TypeError):
        policy.shadow["mismatch_logging"]["diff"] = "values"
    snake_wins = Policy(shadow={"mismatch_logging": {"value": True}, "mismatchLogging": {"value": False}})
    assert snake_wins.shadow == {"mismatch_logging": {"value": True}}


@pytest.mark.parametrize(
    "shadow",
    [
        {"log_mismatches": "yes"},
        {"log_mismatches": None},
        {"mismatch_logging": {"value": "true"}},
        {"mismatch_logging": {"value": None}},
        {"mismatch_logging": {"diff": "full"}},
        {"mismatch_logging": {"diff": 1}},
        {"mismatch_logging": {"diff": None}},
    ],
)
def test_static_policy_rejects_invalid_mismatch_logging(shadow):
    with pytest.raises(ConfigError):
        validate_static_policy(Policy(shadow=shadow))


def test_static_policy_accepts_valid_mismatch_logging():
    for shadow in [
        {"mismatch_logging": {"value": True, "diff": "paths"}},
        {"logMismatches": False, "mismatchLogging": {"diff": "values"}},
        {"log_mismatches": True, "mismatch_logging": {"value": False, "diff": "off"}},
    ]:
        assert validate_static_policy(Policy(shadow=shadow)).shadow is not UNSET
