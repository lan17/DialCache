import math

import pytest

from dialcache.config import (
    MAX_CACHE_TTL_SEC,
    MAX_TIMER_DELAY_MS,
    UNSET,
    Policy,
    deterministic_ramp_sample,
    merge_policy,
    normalize_policy,
    resolve_layer,
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
    assert merged.shadow == {"ramp": 0, "log_mismatches": True}
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
    assert merged.shadow == {"ramp": 0, "log_mismatches": False}
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
