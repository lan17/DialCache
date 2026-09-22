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
    if "log_mismatches" in value:
        result["log_mismatches"] = value["log_mismatches"]
    elif "logMismatches" in value:
        result["log_mismatches"] = value["logMismatches"]
    return MappingProxyType(result)


@dataclass(frozen=True)
class Policy:
    """Per-use-case policy; omitted fields inherit in runtime overlays.

    ``None`` is a supplied value, never an omitted leaf. Constructing a Policy
    validates container shapes, boolean switches and read deadlines. TTL,
    ramp and optional shadow/recovery leaves remain available for narrow
    runtime fail-open resolution. Static operation setup uses
    :func:`validate_static_policy` to reject invalid defaults before calls.
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
            shadow={"ramp": 0, "log_mismatches": False},
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
    if base.shadow is UNSET and overlay.shadow is UNSET:
        values["shadow"] = UNSET
    else:
        values["shadow"] = {
            **({} if base.shadow is UNSET else base.shadow),
            **({} if overlay.shadow is UNSET else overlay.shadow),
        }
    return Policy(**values)


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
