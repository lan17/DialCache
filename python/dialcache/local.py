"""Bounded process-local LRU storage with whole-millisecond expiry."""

from __future__ import annotations

import math
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

from .clock import Clock, SystemClock
from .errors import ConfigError

MISSING = object()
MAX_SAFE_INTEGER = 9_007_199_254_740_991


@dataclass(frozen=True)
class _Entry:
    value: Any
    expires_at_ms: int


class LocalCache:
    """Local entries are shared by the use cases on one cache instance.

    Reads promote recency but never renew expiration. ``None`` is a present
    value. A zero capacity disables storage while leaving policy eligibility
    and coalescing to the core engine.
    """

    def __init__(self, max_size: int = 10_000, clock: Clock | None = None) -> None:
        if (
            isinstance(max_size, bool)
            or not isinstance(max_size, int)
            or max_size < 0
            or max_size > MAX_SAFE_INTEGER
        ):
            raise ConfigError("local_max_size must be a nonnegative safe integer")
        self.max_size = max_size
        self.clock = clock if clock is not None else SystemClock()
        self._entries: OrderedDict[str, _Entry] = OrderedDict()

    def _get_entry(self, key: str, now_ms: float | None = None) -> _Entry | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        now = math.floor(self.clock.monotonic_ms() if now_ms is None else now_ms)
        if now >= entry.expires_at_ms:
            del self._entries[key]
            return None
        self._entries.move_to_end(key)
        return entry

    def get(self, key: str, now_ms: float | None = None) -> Any:
        entry = self._get_entry(key, now_ms)
        return MISSING if entry is None else entry.value

    def read(self, key: str) -> tuple[bool, Any]:
        entry = self._get_entry(key)
        return (False, None) if entry is None else (True, entry.value)

    def put(self, key: str, value: Any, ttl_sec: int) -> None:
        if self.max_size == 0:
            return
        from .config import cache_ttl_sec_to_ms

        ttl_ms = cache_ttl_sec_to_ms(ttl_sec)
        self._entries[key] = _Entry(value, math.floor(self.clock.monotonic_ms()) + ttl_ms)
        self._entries.move_to_end(key)
        while len(self._entries) > self.max_size:
            self._entries.popitem(last=False)

    def clear(self) -> None:
        self._entries.clear()

    def __len__(self) -> int:
        return len(self._entries)
