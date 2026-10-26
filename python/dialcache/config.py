"""Sparse runtime policy and the portable DialCache configuration domains."""

from __future__ import annotations

import math
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from types import MappingProxyType
from typing import Any

from .errors import ConfigError

MAX_SAFE_INTEGER = 9_007_199_254_740_991
MAX_CACHE_TTL_SEC = 31_536_000
MAX_SUPPORTED_DURATION_MS = MAX_CACHE_TTL_SEC * 1_000
MAX_TRACKED_REDIS_VALUE_TTL_MS = 3_600_000
MAX_TIMER_DELAY_MS = 2_147_483_647
DEFAULT_REMOTE_READ_TIMEOUT_MS = 50
DEFAULT_FALLBACK_TIMEOUT_MS = 60_000


class _Unset:
    __slots__ = ()

    def __repr__(self) -> str:
        return "UNSET"


UNSET = _Unset()


class CacheLayer(StrEnum):
    LOCAL = "local"
    REMOTE = "remote"


def is_safe_integer(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and abs(value) <= MAX_SAFE_INTEGER
        and math.isfinite(value)
        and value == int(value)
    )


def is_supported_cache_ttl_sec(value: Any) -> bool:
    return is_safe_integer(value) and 0 < value <= MAX_CACHE_TTL_SEC


def cache_ttl_sec_to_ms(value: Any) -> int:
    if not is_supported_cache_ttl_sec(value):
        raise ConfigError(f"cache TTL must be an integer from 1 through {MAX_CACHE_TTL_SEC} seconds")
    return int(value) * 1_000


def validate_deadline_ms(value: Any, name: str = "deadline") -> int:
    if not is_safe_integer(value) or value <= 0 or value > MAX_TIMER_DELAY_MS:
        raise ConfigError(f"{name} must be an integer from 1 through {MAX_TIMER_DELAY_MS} milliseconds")
    return int(value)


def _layer_map(value: Any, name: str) -> Mapping[str, Any]:
    if value is UNSET:
        return MappingProxyType({})
    if not isinstance(value, Mapping):
        raise ConfigError(f"{name} must be a layer map")
    # Only the supported layers participate in the portable policy.
    return MappingProxyType({layer: value[layer] for layer in ("local", "remote") if layer in value})


def _shadow_map(value: Any) -> Any:
    if value is UNSET:
        return UNSET
    if not isinstance(value, Mapping):
        raise ConfigError("shadow must be an object")
    result: dict[str, Any] = {}
    if "ramp" in value:
        result["ramp"] = value["ramp"]
    for native, portable in (("log_mismatches", "logMismatches"), ("mismatch_logging", "mismatchLogging")):
        if native in value:
            result[native] = value[native]
        elif portable in value:
            result[native] = value[portable]
    if "mismatch_logging" in result:
        result["mismatch_logging"] = _mismatch_logging_map(result["mismatch_logging"])
    return MappingProxyType(result)


def _mismatch_logging_map(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ConfigError("shadow.mismatch_logging must be an object")
    # Leaf values stay unvalidated, like layer-map leaves, so a malformed
    # runtime leaf fails open narrowly at resolution.
    return MappingProxyType({leaf: value[leaf] for leaf in ("value", "diff") if leaf in value})


@dataclass(frozen=True)
class Policy:
    """Per-use-case policy; omitted fields inherit in runtime overlays.

    ``None`` is a supplied value, never an omitted leaf. Constructing a Policy
    validates container shapes, boolean switches and read deadlines. TTL,
    ramp and optional shadow/recovery leaves remain available for narrow
    runtime fail-open resolution. Static operation setup uses
    :func:`validate_static_policy` to reject invalid defaults before calls.

    ``shadow`` takes ``ramp`` and the confirmed-mismatch warning content:
    ``mismatch_logging={"value": bool, "diff": "off" | "paths" | "values"}``,
    both leaves off when omitted, and ``log_mismatches``, shorthand for
    ``{"value": True, "diff": "values"}`` when true and for both leaves off
    when false. A leaf written beside the shorthand overrides what it expands
    to; a runtime overlay's leaves then win leaf by leaf. The camelCase names
    ``mismatchLogging`` and ``logMismatches`` are accepted.
    """

    ttl_sec: Mapping[str, Any] = field(default_factory=dict)
    ramp: Mapping[str, Any] = field(default_factory=dict)
    request_local: Any = UNSET
    coalesce: Any = UNSET
    stale_on_error_max_age_sec: Any = UNSET
    remote_read_timeout_ms: Any = UNSET
    shadow: Any = UNSET

    def __post_init__(self) -> None:
        object.__setattr__(self, "ttl_sec", _layer_map(self.ttl_sec, "ttl_sec"))
        object.__setattr__(self, "ramp", _layer_map(self.ramp, "ramp"))
        object.__setattr__(self, "shadow", _shadow_map(self.shadow))
        for name in ("request_local", "coalesce"):
            value = getattr(self, name)
            if value is not UNSET and not isinstance(value, bool):
                raise ConfigError(f"{name} must be a boolean")
        if self.remote_read_timeout_ms is not UNSET:
            validate_deadline_ms(self.remote_read_timeout_ms, "remote_read_timeout_ms")

    @classmethod
    def enabled(cls, ttl_sec: int) -> Policy:
        return cls(ttl_sec={"local": ttl_sec, "remote": ttl_sec}, ramp={"local": 100, "remote": 100})

    @classmethod
    def disabled(cls) -> Policy:
        """Disable every inherited serving, recovery and shadow path."""
        return cls(
            request_local=False,
            stale_on_error_max_age_sec=0,
            # Leaves merge independently, so both are written: an omitted one
            # would let an inherited leaf survive disabled().
            shadow={"ramp": 0, "mismatch_logging": {"value": False, "diff": "off"}},
            ramp={"local": 0, "remote": 0},
        )

    @classmethod
    def from_mapping(cls, value: Mapping[str, Any]) -> Policy:
        result = normalize_policy(value)
        assert result is not None
        return result


KeyConfig = Policy
DialCacheKeyConfig = Policy
PolicyInput = Policy | Mapping[str, Any] | None

_ALIASES = {
    "ttl_sec": "ttlSec",
    "ramp": "ramp",
    "request_local": "requestLocal",
    "coalesce": "coalesce",
    "stale_on_error_max_age_sec": "staleOnErrorMaxAgeSec",
    "remote_read_timeout_ms": "remoteReadTimeoutMs",
    "shadow": "shadow",
}


def normalize_policy(value: PolicyInput) -> Policy | None:
    if value is None:
        return None
    if isinstance(value, Policy):
        return value
    if not isinstance(value, Mapping):
        raise ConfigError("DialCache policy must be an object")
    if "shadowRamp" in value or "shadow_ramp" in value:
        raise ConfigError('shadow_ramp was replaced by "shadow.ramp"')
    supplied: dict[str, Any] = {}
    for native, portable in _ALIASES.items():
        if native in value:
            supplied[native] = value[native]
        elif portable in value:
            supplied[native] = value[portable]
    return Policy(**supplied)


def merge_policy(defaults: PolicyInput, runtime: PolicyInput) -> Policy | None:
    """Snapshot a sparse provider reply over the operation's static policy.

    A whole-provider ``None`` inherits the static policy. Invalid explicitly
    supplied leaves stay supplied, including ``None``, so runtime resolution
    cannot accidentally enable an inherited layer.
    """
    base = normalize_policy(defaults)
    overlay = normalize_policy(runtime)
    if overlay is None:
        return base
    if base is None:
        return overlay
    values: dict[str, Any] = {
        "ttl_sec": {**base.ttl_sec, **overlay.ttl_sec},
        "ramp": {**base.ramp, **overlay.ramp},
    }
    for name in ("request_local", "coalesce", "stale_on_error_max_age_sec", "remote_read_timeout_ms"):
        value = getattr(overlay, name)
        values[name] = getattr(base, name) if value is UNSET else value
    values["shadow"] = _merge_shadow(base.shadow, overlay.shadow)
    return Policy(**values)


def _merge_shadow(base: Any, overlay: Any) -> Any:
    if base is UNSET and overlay is UNSET:
        return UNSET
    defaults: Mapping[str, Any] = {} if base is UNSET else base
    runtime: Mapping[str, Any] = {} if overlay is UNSET else overlay
    merged: dict[str, Any] = {}
    if "ramp" in runtime:
        merged["ramp"] = runtime["ramp"]
    elif "ramp" in defaults:
        merged["ramp"] = defaults["ramp"]
    # Each layer's shorthand expands before the leaf-wise merge, so a runtime
    # log_mismatches replaces both inherited leaves while a leaf written beside
    # it still wins within its own layer.
    inherited = expand_mismatch_logging(defaults)
    written = expand_mismatch_logging(runtime)
    # Only the runtime layer can carry a malformed shorthand: static validation
    # rejects one in the operation's defaults. It stays raw, so admission
    # records its config_resolution; its expanded leaves already won the merge.
    if written.get("invalid"):
        merged["log_mismatches"] = runtime["log_mismatches"]
    group = {
        leaf: written[leaf] if leaf in written else inherited[leaf]
        for leaf in ("value", "diff")
        if leaf in written or leaf in inherited
    }
    if group:
        merged["mismatch_logging"] = group
    return merged


MISMATCH_DIFF_LEVELS = ("off", "paths", "values")


@dataclass(frozen=True)
class MismatchLogging:
    """The effective mismatch-logging leaves and whether any written input was invalid."""

    value: bool
    diff: str
    invalid: bool


def expand_mismatch_logging(shadow: Mapping[str, Any]) -> dict[str, Any]:
    """Expand one shadow group's shorthand into the leaves it stands for.

    ``log_mismatches=True`` expands to ``{"value": True, "diff": "values"}`` and
    ``False`` to ``{"value": False, "diff": "off"}``; then the leaves written in
    the same group's ``mismatch_logging`` override them. A malformed shorthand
    expands to both leaves off and is marked ``invalid``. An omitted leaf stays
    omitted, and written leaves pass through unvalidated.
    """
    expanded: dict[str, Any] = {}
    if "log_mismatches" in shadow:
        shorthand = shadow["log_mismatches"]
        if shorthand is True:
            expanded = {"value": True, "diff": "values"}
        elif shorthand is False:
            expanded = {"value": False, "diff": "off"}
        else:
            expanded = {"value": False, "diff": "off", "invalid": True}
    if "mismatch_logging" not in shadow:
        return expanded
    group = shadow["mismatch_logging"]
    return {**expanded, **{leaf: group[leaf] for leaf in ("value", "diff") if leaf in group}}


def resolve_mismatch_logging(shadow: Mapping[str, Any]) -> MismatchLogging:
    """Resolve the effective mismatch-logging leaves of one shadow group.

    Each leaf validates independently: an omitted leaf is off, an invalid leaf
    acts off, and ``invalid`` reports that the group owes one config_resolution.
    """
    leaves = expand_mismatch_logging(shadow)
    value = leaves.get("value", False)
    diff = leaves.get("diff", "off")
    valid_value = isinstance(value, bool)
    valid_diff = _valid_diff_level(diff)
    return MismatchLogging(
        value=value if valid_value else False,
        diff=diff if valid_diff else "off",
        invalid=bool(leaves.get("invalid")) or not valid_value or not valid_diff,
    )


def _valid_diff_level(value: Any) -> bool:
    return isinstance(value, str) and value in MISMATCH_DIFF_LEVELS


def _valid_ramp(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and 0 <= value <= 100
        and math.isfinite(value)
    )


def validate_static_policy(value: PolicyInput) -> Policy | None:
    """Validate and capture operation defaults before registering the use case."""
    policy = normalize_policy(value)
    if policy is None:
        return None
    for layer in ("local", "remote"):
        if layer in policy.ttl_sec and not is_supported_cache_ttl_sec(policy.ttl_sec[layer]):
            raise ConfigError(f"ttl_sec.{layer} must be an integer from 1 through {MAX_CACHE_TTL_SEC}")
        if layer in policy.ramp and not _valid_ramp(policy.ramp[layer]):
            raise ConfigError(f"ramp.{layer} must be a finite number from 0 through 100")
    age = policy.stale_on_error_max_age_sec
    if age is not UNSET:
        if not is_safe_integer(age) or age < 0 or age > MAX_CACHE_TTL_SEC:
            raise ConfigError("stale_on_error_max_age_sec must be a supported nonnegative integer")
        if age > 0 and ("remote" not in policy.ttl_sec or age <= policy.ttl_sec["remote"]):
            raise ConfigError("stale_on_error_max_age_sec requires a smaller positive remote TTL")
    if policy.shadow is not UNSET:
        if "ramp" in policy.shadow and not _valid_ramp(policy.shadow["ramp"]):
            raise ConfigError("shadow.ramp must be a finite number from 0 through 100")
        if "log_mismatches" in policy.shadow and not isinstance(policy.shadow["log_mismatches"], bool):
            raise ConfigError("shadow.log_mismatches must be a boolean")
        mismatch_logging = policy.shadow.get("mismatch_logging", {})
        if "value" in mismatch_logging and not isinstance(mismatch_logging["value"], bool):
            raise ConfigError("shadow.mismatch_logging.value must be a boolean")
        if "diff" in mismatch_logging and not _valid_diff_level(mismatch_logging["diff"]):
            raise ConfigError('shadow.mismatch_logging.diff must be "off", "paths" or "values"')
    return policy


def deterministic_ramp_sample(urn: str, layer: str) -> float:
    """Stable FNV-1a over UTF-16 code units, identical across DialCache ports."""
    encoded = f"{urn}:{layer}".encode("utf-16-le", errors="surrogatepass")
    value = 0x811C9DC5
    for index in range(0, len(encoded), 2):
        value ^= encoded[index] | (encoded[index + 1] << 8)
        value = (value * 0x01000193) & 0xFFFFFFFF
    return value / 0x1_0000_0000 * 100


def deterministic_shadow_ramp_sample(urn: str) -> float:
    return deterministic_ramp_sample(urn, "shadow")


@dataclass(frozen=True)
class LayerResolution:
    status: str
    reason: str | None = None
    ttl_sec: int | None = None
    ramp: float | None = None
    stale_on_error_max_age_sec: int | None = None
    stale_on_error_config_error: bool = False

    @property
    def enabled(self) -> bool:
        return self.status == "enabled"


def resolve_layer(policy: Policy | None, urn: str, layer: str | CacheLayer) -> LayerResolution:
    """Resolve one serving layer; malformed leaves disable only that layer."""
    if layer not in ("local", "remote"):
        raise ConfigError(f"Unknown cache layer: {layer}")
    age = UNSET if policy is None else policy.stale_on_error_max_age_sec
    recovery_off = age is UNSET or (is_safe_integer(age) and age == 0)
    if policy is None or layer not in policy.ttl_sec:
        return LayerResolution(
            "disabled",
            "policy_disabled",
            stale_on_error_config_error=layer == "remote" and not recovery_off,
        )
    ttl = policy.ttl_sec[layer]
    if not is_supported_cache_ttl_sec(ttl):
        return LayerResolution("disabled", "invalid_ttl")
    ramp = policy.ramp.get(layer, 100)
    if not _valid_ramp(ramp):
        return LayerResolution("disabled", "invalid_ramp")
    enabled = ramp >= 100 or (ramp > 0 and deterministic_ramp_sample(urn, str(layer)) < ramp)
    recovery = None
    recovery_error = False
    if layer == "remote" and not recovery_off:
        if is_supported_cache_ttl_sec(age) and age > ttl:
            recovery = int(age)
        else:
            recovery_error = True
    return LayerResolution(
        status="enabled" if enabled else "disabled",
        reason=None if enabled else "ramped_down",
        ttl_sec=int(ttl),
        ramp=float(ramp),
        stale_on_error_max_age_sec=recovery,
        stale_on_error_config_error=recovery_error,
    )
