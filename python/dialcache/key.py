"""Portable DialCache identity, URI escaping, and deterministic cohorts."""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import NotRequired, TypeAlias, TypedDict
from urllib.parse import quote

from .serializer import UNDEFINED, _Undefined

KeyScalar: TypeAlias = str | int | float | bool | None


class CacheKeySpec(TypedDict):
    """An entity id and the explicit result dimensions selected for a cache key."""

    id: KeyScalar
    args: NotRequired[Mapping[str, KeyScalar | _Undefined]]


def _integer_string(value: int) -> str:
    # Python's configurable decimal-digit guard must not truncate bigint identity.
    negative = value < 0
    value = abs(value)
    parts: list[int] = []
    while value >= 1_000_000_000:
        value, remainder = divmod(value, 1_000_000_000)
        parts.append(remainder)
    result = str(value) + "".join(f"{part:09d}" for part in reversed(parts))
    return "-" + result if negative else result


def scalar_string(value: object) -> str:
    """JavaScript-compatible scalar spelling; Python integers retain all digits.

    Python's shortest-round-trip float digits use the same nearest-even rule;
    ECMAScript differs in the decimal/exponent presentation thresholds.
    """
    if isinstance(value, str):
        return value
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return _integer_string(value)
    if isinstance(value, float):
        if math.isnan(value):
            return "NaN"
        if math.isinf(value):
            return "-Infinity" if value < 0 else "Infinity"
        if value == 0:
            return "0"
        sign = "-" if value < 0 else ""
        raw = repr(abs(value)).lower()
        coefficient, _, exponent = raw.partition("e")
        whole, _dot, fraction = coefficient.partition(".")
        digits = (whole + fraction).lstrip("0")
        position = len(whole) + (int(exponent) if exponent else 0)
        if whole == "0":
            position -= len(whole + fraction) - len(digits)
        digits = digits.rstrip("0")
        if 0 < position <= 21:
            return sign + (
                digits[:position] + "." + digits[position:]
                if position < len(digits)
                else digits + "0" * (position - len(digits))
            )
        if -6 < position <= 0:
            return sign + "0." + "0" * -position + digits
        mantissa = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
        power = position - 1
        return sign + mantissa + "e" + ("+" if power >= 0 else "") + str(power)
    raise TypeError("Cache key scalar must be str, int, float, bool, or None")


def _scalar_text(value: str, *, replace: bool = False) -> str:
    """Combine explicit UTF-16 pairs; reject (keys) or replace (payloads) lone units."""
    if not isinstance(value, str):
        raise TypeError("Cache key components must be strings")
    return value.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace" if replace else "strict")


def encode_component(value: str) -> str:
    return quote(_scalar_text(value), safe="~!*'()-._", encoding="utf-8", errors="strict")


def normalize_args(args: Mapping[str, object]) -> tuple[tuple[str, str], ...]:
    """Omit UNDEFINED and sort names by UTF-16 units; None remains literal null."""
    pairs = [(name, scalar_string(value)) for name, value in args.items() if value is not UNDEFINED]
    pairs.sort(key=lambda pair: pair[0].encode("utf-16-be", "surrogatepass"))
    return tuple(pairs)


def invalidation_prefix(namespace: str, key_type: str, id: object) -> str:
    entity_id = scalar_string(id)
    for name, value in [("namespace", namespace), ("key_type", key_type), ("id", entity_id)]:
        if "{" in value or "}" in value:
            raise ValueError(f"Tracked {name} must not contain braces")
    return ":".join(encode_component(part) for part in (namespace, key_type, entity_id))


@dataclass(frozen=True)
class Key:
    namespace: str
    key_type: str
    id: object
    use_case: str
    args: Sequence[tuple[str, str]] = ()
    tracked: bool = False
    prefix: str = field(init=False)
    logical: str = field(init=False)
    value_key: str = field(init=False)
    watermark_key: str | None = field(init=False)

    def __post_init__(self) -> None:
        if "{" in self.namespace or "}" in self.namespace:
            raise ValueError("DialCache namespace must not contain braces")
        entity_id = scalar_string(self.id)
        pairs = tuple((name, value) for name, value in self.args)
        if self.tracked:
            prefix = "{" + invalidation_prefix(self.namespace, self.key_type, entity_id) + "}"
        else:
            prefix = ":".join(encode_component(part) for part in (self.namespace, self.key_type, entity_id))
        query = (
            "?" + "&".join(f"{encode_component(name)}={encode_component(value)}" for name, value in pairs)
            if pairs
            else ""
        )
        logical = prefix + query + "#" + encode_component(self.use_case)
        object.__setattr__(self, "id", entity_id)
        object.__setattr__(self, "args", pairs)
        object.__setattr__(self, "prefix", prefix)
        object.__setattr__(self, "logical", logical)
        object.__setattr__(self, "value_key", logical + ":dialcache-frame-v1")
        object.__setattr__(self, "watermark_key", prefix + "#watermark" if self.tracked else None)

    @property
    def urn(self) -> str:
        return self.logical

    def __str__(self) -> str:
        return self.logical


def ramp_hash(key: Key | str, discriminator: str) -> int:
    units = (str(key) + ":" + discriminator).encode("utf-16-le", "surrogatepass")
    hashed = 0x811C9DC5
    for offset in range(0, len(units), 2):
        hashed = ((hashed ^ (units[offset] | units[offset + 1] << 8)) * 0x01000193) & 0xFFFFFFFF
    return hashed


def ramp_sample(key: Key | str, discriminator: str) -> float:
    return ramp_hash(key, discriminator) / 0x1_0000_0000 * 100
