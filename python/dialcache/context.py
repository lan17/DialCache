"""Per-instance request scope with a shared, explicitly closed memo holder."""

from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from types import TracebackType
from typing import Any


@dataclass
class RequestLocalCache:
    """Request values and flights; closing prevents all late publication."""

    in_flight: dict[str, Any] = field(default_factory=dict)
    _values: dict[str, Any] = field(default_factory=dict)
    closed: bool = False

    def read(self, key: str) -> tuple[bool, Any]:
        if self.closed or key not in self._values:
            return False, None
        return True, self._values[key]

    def set(self, key: str, value: Any) -> None:
        if not self.closed:
            self._values[key] = value

    def close(self) -> None:
        self.closed = True
        self._values.clear()
        self.in_flight.clear()


@dataclass
class _Holder:
    closed: bool = False
    memo: RequestLocalCache | None = None

    def close(self) -> None:
        self.closed = True
        if self.memo is not None:
            self.memo.close()
            self.memo = None


@dataclass(frozen=True)
class _Store:
    enabled: bool
    holder: _Holder | None


class _Scope:
    def __init__(self, context: DialCacheContext, enabled: bool) -> None:
        self._context = context
        self._enabled = enabled
        self._token: Token[_Store | None] | None = None
        self._owned: _Holder | None = None
        self._entered = False

    def __enter__(self) -> _Scope:
        if self._entered:
            raise RuntimeError("A DialCache scope context manager can only be entered once")
        self._entered = True
        holder = self._context._live_holder()
        if self._enabled and holder is None:
            holder = self._owned = _Holder()
        self._token = self._context._storage.set(_Store(self._enabled, holder))
        return self

    def __exit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._token is None:
            raise RuntimeError("DialCache scope was not entered or was already closed")
        if self._owned is not None:
            self._owned.close()
        self._context._storage.reset(self._token)
        self._token = None

    async def __aenter__(self) -> _Scope:
        return self.__enter__()

    async def __aexit__(
        self,
        exception_type: type[BaseException] | None,
        exception: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.__exit__(exception_type, exception, traceback)


class DialCacheContext:
    """An independently enabled context for one cache instance.

    Both ``with context.enable():`` and ``async with context.enable():`` are
    supported. Async tasks inherit the live holder, but calls made after its
    outer scope exits are disabled, even from a copied context.
    """

    def __init__(self) -> None:
        self._storage: ContextVar[_Store | None] = ContextVar("dialcache_scope", default=None)

    def _live_holder(self) -> _Holder | None:
        store = self._storage.get()
        if store is None or store.holder is None or store.holder.closed:
            return None
        return store.holder

    def is_enabled(self) -> bool:
        store = self._storage.get()
        return store is not None and store.enabled and self._live_holder() is not None

    def enable(self) -> _Scope:
        return _Scope(self, True)

    def disable(self) -> _Scope:
        return _Scope(self, False)

    def request_cache(self) -> RequestLocalCache | None:
        if not self.is_enabled():
            return None
        holder = self._live_holder()
        assert holder is not None
        if holder.memo is None:
            holder.memo = RequestLocalCache()
        return holder.memo


def get_or_create_request_local_cache(context: DialCacheContext) -> RequestLocalCache | None:
    return context.request_cache()
