"""Caller-supplied serialization and the portable JSON value binding."""

from __future__ import annotations

import json
from collections.abc import Awaitable
from typing import Protocol, TypeVar

T = TypeVar("T")
Payload = str | bytes


class _Undefined:
    __slots__ = ()

    def __repr__(self) -> str:
        return "UNDEFINED"


UNDEFINED = _Undefined()
JSON_UNDEFINED_SENTINEL = "__dialcache_json_undefined_v1__"


class Serializer(Protocol[T]):
    """Payloads are immutable. Asynchronous methods need an application deadline."""

    def dump(self, value: T) -> Payload | Awaitable[Payload]: ...
    def load(self, value: Payload) -> T | Awaitable[T]: ...


class JsonSerializer:
    """Compact native JSON, plus the cross-language top-level undefined sentinel.

    Nonfinite numbers and values outside JSON's domain are rejected. For custom
    Python types, supply a Serializer with an explicit portable representation.
    """

    def dump(self, value: object) -> str:
        if value is UNDEFINED:
            return JSON_UNDEFINED_SENTINEL
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        # JSON must escape lone surrogate units before the frame's UTF-8 text
        # boundary replaces malformed text. This preserves JSON string values
        # in the same way as well-formed ECMAScript JSON.stringify.
        return payload.encode("utf-8", errors="backslashreplace").decode("utf-8")

    def load(self, value: Payload) -> object:
        payload = value.decode("utf-8", errors="replace") if isinstance(value, bytes) else value
        if payload == JSON_UNDEFINED_SENTINEL:
            return UNDEFINED
        return json.loads(payload, parse_constant=self._reject_constant)

    @staticmethod
    def _reject_constant(value: str) -> object:
        raise ValueError(f"Invalid JSON constant: {value}")
