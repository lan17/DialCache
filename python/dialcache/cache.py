"""Async DialCache engine: admission, captured policy, traversal and ownership.

The implementation follows formal/SPEC.md. External work is kept alive when a
deadline stops a caller waiting: timing out never grants late work permission
to publish a value or cancels another caller's shared source.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
import logging
import math
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, ParamSpec, TypeVar

from .clock import SystemClock
from .config import UNSET, Policy, merge_policy, resolve_layer, validate_static_policy
from .context import DialCacheContext
from .errors import (
    ConfigError,
    FallbackTimeoutError,
    MissingRemoteError,
    RemoteReadTimeoutError,
    UseCaseIsAlreadyRegisteredError,
    UseCaseNameIsReservedError,
)
from .key import Key, invalidation_prefix, normalize_args, ramp_sample
from .local import LocalCache
from .protocol import Frame, Miss, compress_payload, decompress_payload, escape_raw_payload, utf8_bytes
from .redis import InvalidationRequest, ReadContext, ReadRequest, WriteRequest
from .serializer import JsonSerializer

T = TypeVar("T")
P = ParamSpec("P")
MAX_SAFE = 9_007_199_254_740_991


async def _await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


def _valid_integer(value: Any, minimum: int = 0, maximum: int = MAX_SAFE) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and minimum <= value <= maximum
        and math.isfinite(value)
        and int(value) == value
    )


def _deep_equal(left: Any, right: Any) -> bool:
    """Keep booleans distinct from numbers in JSON-like semantic comparisons."""
    if isinstance(left, bool) or isinstance(right, bool):
        return left is right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        if left == 0 and right == 0:
            return math.copysign(1, left) == math.copysign(1, right)
        return left == right or (
            isinstance(left, float) and isinstance(right, float) and math.isnan(left) and math.isnan(right)
        )
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_deep_equal(left[k], right[k]) for k in left)
    if isinstance(left, (list, tuple)):
        return len(left) == len(right) and all(_deep_equal(a, b) for a, b in zip(left, right))
    return left == right


def _budget(value: Any) -> int | None:
    if value is None:
        return None
    if not _valid_integer(value, 1, 2_147_483_647):
        raise ConfigError("fallback_timeout_ms must be None or a positive integer <= 2147483647")
    return int(value)


class AbortSignal:
    """Cooperative read cancellation; adapters may register an abort callback."""

    def __init__(self) -> None:
        self.aborted = False
        self._callbacks: list[Callable[[], Any]] = []

    def add_callback(self, callback: Callable[[], Any]) -> None:
        if self.aborted:
            callback()
        else:
            self._callbacks.append(callback)

    def abort(self) -> None:
        if self.aborted:
            return
        self.aborted = True
        callbacks, self._callbacks = self._callbacks, []
        for callback in callbacks:
            try:
                callback()
            except Exception:
                pass


@dataclass
class _Flight:
    task: asyncio.Future[Any]
    started: float
    followers: int = 0


@dataclass
class _Operation:
    load: Callable[[], Any]
    select_key: Callable[[], Any]
    key_type: str
    use_case: str
    policy: Policy
    timeout: int | None
    serializer: Any
    tracked: bool
    comparator: Callable[[Any, Any], bool]
    recovery: Callable[[BaseException], bool]
    did_timeout: bool = False


@dataclass
class _Shadow:
    started: float
    budget: int
    pending_reads: set[asyncio.Task[Any]] = field(default_factory=set)
    finished: bool = False
    abandoned: bool = False


class DialCache:
    """Explicitly enabled caching for one asyncio event loop.

    The application owns Redis connections. Instances have independent scopes,
    LRU storage and in-flight tables. Values held in memory are shared by
    reference and should be treated as immutable.
    """

    def __init__(
        self,
        *,
        namespace: str = "urn",
        redis: Any = None,
        policy_provider: Callable[[Key], Any] | None = None,
        metrics: Any = None,
        logger: Any = None,
        clock: Any = None,
        local_max_size: int = 10_000,
        local_store: Any = None,
        shadow_max_in_flight: int = 1,
        read_timeout_ms: int = 50,
        should_attempt_stale_recovery: Callable[[BaseException], bool] | None = None,
        serializer: Any = None,
        compression: Any = True,
    ) -> None:
        if not isinstance(namespace, str) or "{" in namespace or "}" in namespace:
            raise ConfigError("namespace must be a string without braces")
        if not _valid_integer(local_max_size):
            raise ConfigError("local_max_size must be a nonnegative safe integer")
        if not _valid_integer(shadow_max_in_flight, 1):
            raise ConfigError("shadow_max_in_flight must be a positive safe integer")
        if not _valid_integer(read_timeout_ms, 1, 2_147_483_647):
            raise ConfigError("read_timeout_ms must be a positive bounded integer")
        if should_attempt_stale_recovery is not None and not callable(should_attempt_stale_recovery):
            raise ConfigError("should_attempt_stale_recovery must be callable")
        if compression is not True and compression is not False and not isinstance(compression, Mapping):
            raise ConfigError("compression must be True, False, or an options mapping")
        if isinstance(compression, Mapping):
            compression = dict(compression)
            if set(compression) - {"threshold_bytes", "level"}:
                raise ConfigError("compression supports threshold_bytes and level")
            if not _valid_integer(compression.get("threshold_bytes", 4096), 1):
                raise ConfigError("compression.threshold_bytes must be a positive safe integer")
            if not _valid_integer(compression.get("level", 3), 1, 22):
                raise ConfigError("compression.level must be an integer from 1 through 22")
        self.namespace, self.redis = namespace, redis
        self.policy_provider, self.metrics = policy_provider, metrics
        self.logger = logger or logging.getLogger("dialcache")
        self.clock = clock or SystemClock()
        self._context = DialCacheContext()
        self._local = local_store if local_store is not None else LocalCache(local_max_size, self.clock)
        self._flights: dict[str, _Flight] = {}
        self._shadows: dict[str, _Shadow] = {}
        self._registered: set[str] = set()
        self._tasks: set[asyncio.Task[Any]] = set()
        self._shadow_max = shadow_max_in_flight
        self.read_timeout_ms = read_timeout_ms
        self.serializer = serializer or JsonSerializer()
        self.compression = compression
        self._recovery = should_attempt_stale_recovery or (
            lambda error: isinstance(error, FallbackTimeoutError)
        )

    def enable(self, enabled: bool = True) -> Any:
        """Enable a request scope; nested scopes share the live outer memo."""
        return self._context.enable() if enabled else self._context.disable()

    def disable(self) -> Any:
        """Temporarily disable caching, preserving a live outer request memo."""
        return self._context.disable()

    def is_enabled(self) -> bool:
        return self._context.is_enabled()

    def get_coalescing_state(self) -> dict[str, Any]:
        """Report live process leaders, followers and oldest leader age."""
        return {
            "process": {
                "active_leaders": len(self._flights),
                "active_followers": sum(f.followers for f in self._flights.values()),
                "oldest_leader_age_ms": max(
                    0, self.clock.monotonic_ms() - next(iter(self._flights.values())).started
                )
                if self._flights
                else None,
            }
        }

    def cached(
        self,
        *,
        key_type: str,
        cache_key: Callable[..., Any] | None = None,
        id_arg: str | tuple[str, Callable[[Any], Any]] | None = None,
        use_case: str | None = None,
        arg_adapters: Mapping[str, Callable[[Any], Any]] | None = None,
        ignore_args: list[str] | tuple[str, ...] = (),
        **options: Any,
    ) -> Callable[..., Any]:
        """Decorate a loader using an explicit selector or gcache-style arguments.

        The wrapper is always awaitable, including for a synchronous loader.
        Key callbacks and argument adapters are never called while disabled.
        """
        if (cache_key is None) == (id_arg is None):
            raise ConfigError("Supply exactly one of cache_key or id_arg")

        def decorate(fn: Callable[P, T | Awaitable[T]]) -> Callable[P, Awaitable[T]]:
            name = use_case or f"{fn.__module__}.{fn.__qualname__}"
            self._check_use_case(name)
            if name in self._registered:
                raise UseCaseIsAlreadyRegisteredError(name)
            signature = inspect.signature(fn)
            adapters = dict(arg_adapters or {})
            ignored = frozenset(ignore_args)
            # Validate/snapshot static settings once, before reserving the name.
            prototype = self._operation(lambda: None, lambda: None, key_type, name, **options)
            id_name = id_arg[0] if isinstance(id_arg, tuple) else id_arg
            if id_name is not None and id_name not in signature.parameters:
                raise ConfigError(f"id_arg does not name a function parameter: {id_name}")
            if any(n not in signature.parameters for n in (*adapters, *ignored)):
                raise ConfigError("arg_adapters and ignore_args must name function parameters")
            self._registered.add(name)

            @functools.wraps(fn)
            async def wrapped(*args: P.args, **kwargs: P.kwargs) -> T:
                def select() -> Any:
                    if cache_key is not None:
                        return cache_key(*args, **kwargs)
                    bound = signature.bind(*args, **kwargs)
                    bound.apply_defaults()
                    entity_id = bound.arguments[id_name]
                    if isinstance(id_arg, tuple):
                        entity_id = id_arg[1](entity_id)
                    key_args = {
                        n: adapters[n](v) if n in adapters else v
                        for n, v in bound.arguments.items()
                        if n != "self" and n not in ignored and (n != id_name or n in adapters)
                    }
                    return {"id": entity_id, "args": key_args}

                op = _Operation(
                    lambda: fn(*args, **kwargs),
                    select,
                    prototype.key_type,
                    name,
                    prototype.policy,
                    prototype.timeout,
                    prototype.serializer,
                    prototype.tracked,
                    prototype.comparator,
                    prototype.recovery,
                )
                return await self._execute(op)

            return wrapped

        return decorate

    async def get_or_load(
        self,
        load: Callable[[], T | Awaitable[T]],
        *,
        key: Any = None,
        key_type: str,
        use_case: str,
        key_selector: Callable[[], Any] | None = None,
        **options: Any,
    ) -> T:
        """Read a key or run its loader. Repeated inline use-case names are valid."""
        op = self._operation(load, key_selector or (lambda: key), key_type, use_case, **options)
        return await self._execute(op)

    async def aget(self, key: Key, fallback: Callable[[], Any], **options: Any) -> Any:
        """Structured-key form of get_or_load, familiar to gcache callers."""
        return await self.get_or_load(
            fallback, key=key, key_type=key.key_type, use_case=key.use_case, **options
        )

    def _operation(
        self,
        load: Callable[[], Any],
        select: Callable[[], Any],
        key_type: str,
        use_case: str,
        *,
        default_config: Any = None,
        fallback_timeout_ms: Any = 60_000,
        serializer: Any = None,
        track_for_invalidation: bool = False,
        shadow_comparator: Any = None,
        should_attempt_stale_recovery: Any = None,
    ) -> _Operation:
        self._check_use_case(use_case)
        policy = validate_static_policy(default_config) or Policy()
        comparator = shadow_comparator if shadow_comparator is not None else _deep_equal
        recovery = (
            should_attempt_stale_recovery if should_attempt_stale_recovery is not None else self._recovery
        )
        if not callable(comparator) or not callable(recovery):
            raise ConfigError("Comparator and recovery predicate must be callable")
        return _Operation(
            load,
            select,
            key_type,
            use_case,
            policy,
            _budget(fallback_timeout_ms),
            serializer or self.serializer,
            track_for_invalidation,
            comparator,
            recovery,
        )

    @staticmethod
    def _check_use_case(name: str) -> None:
        if name == "watermark":
            raise UseCaseNameIsReservedError(name)

    def _spawn(self, work: Awaitable[Any]) -> asyncio.Task[Any]:
        task = asyncio.ensure_future(work)
        self._tasks.add(task)

        def consume(done: asyncio.Task[Any]) -> None:
            self._tasks.discard(done)
            if not done.cancelled():
                done.exception()

        task.add_done_callback(consume)
        return task

    def _emit(self, event: str, labels: Mapping[str, Any], **fields: Any) -> None:
        if self.metrics is None:
            return
        record = {"event": event, **labels, **fields}
        try:
            if callable(self.metrics):
                result = self.metrics(record)
            else:
                result = self.metrics.observe(record)
            self._discard_awaitable(result)
        except Exception:
            pass

    def _log(self, message: str, error: Any = None) -> None:
        try:
            self.logger.warning(message, error) if error is not None else self.logger.warning(message)
        except Exception:
            pass

    def _discard_awaitable(self, value: Any) -> None:
        if inspect.isawaitable(value):
            self._spawn(_await(value))

    def _labels(self, key: Key | _Operation, layer: str | None = None) -> dict[str, Any]:
        labels = {"cacheNamespace": self.namespace, "useCase": key.use_case, "keyType": key.key_type}
        if layer is not None:
            labels["layer"] = layer
        return labels

    def _error(self, key: Any, layer: str, kind: str) -> None:
        self._emit("error", self._labels(key, layer), error=kind, inFallback=False)

    def _seconds(self, start: float) -> float:
        return max(0, self.clock.monotonic_ms() - start) / 1000

    async def _deadline(
        self,
        pending: asyncio.Future[Any],
        budget: int | None,
        error: Callable[[], Exception],
        *,
        started: float | None = None,
        on_timeout: Callable[[], Any] | None = None,
    ) -> Any:
        if budget is None:
            return await asyncio.shield(pending)
        start = self.clock.monotonic_ms() if started is None else started
        result = asyncio.get_running_loop().create_future()
        handle: Any = None

        def timeout() -> None:
            nonlocal handle
            if result.done():
                return
            remaining = budget - max(0, self.clock.monotonic_ms() - start)
            if remaining > 0:
                handle = self.clock.call_later(math.ceil(remaining), timeout)
                return
            if on_timeout is not None:
                try:
                    on_timeout()
                except Exception:
                    pass
            result.set_exception(error())

        def settled(done: asyncio.Future[Any]) -> None:
            if result.done():
                return
            if max(0, self.clock.monotonic_ms() - start) >= budget:
                timeout()
            elif done.cancelled():
                result.cancel()
            elif done.exception() is not None:
                result.set_exception(done.exception())
            else:
                result.set_result(done.result())

        pending.add_done_callback(settled)
        remaining = budget - max(0, self.clock.monotonic_ms() - start)
        handle = self.clock.call_later(max(0, math.ceil(remaining)), timeout)
        try:
            return await result
        finally:
            handle.cancel()
            pending.remove_done_callback(settled)

    async def _source(self, op: _Operation, layer: str) -> Any:
        start = self.clock.monotonic_ms()

        async def invoke() -> Any:
            return await _await(op.load())

        pending = self._spawn(invoke())

        def timeout_error() -> Exception:
            op.did_timeout = True
            return FallbackTimeoutError(op.use_case, op.timeout)

        try:
            return await self._deadline(pending, op.timeout, timeout_error, started=start)
        except Exception:
            self._emit("error", self._labels(op, layer), error="fallback", inFallback=True)
            raise
        finally:
            self._emit("fallback", self._labels(op, layer), seconds=self._seconds(start))

    async def _execute(self, op: _Operation) -> Any:
        if not self.is_enabled():
            self._emit("disabled", self._labels(op, "noop"), reason="context")
            return await _await(op.load())
        try:
            selected = op.select_key()
            if isinstance(selected, Key):
                key = selected
                if key.namespace != self.namespace:
                    raise ValueError("Key namespace differs from cache namespace")
            else:
                spec = selected if isinstance(selected, Mapping) else {"id": selected}
                key = Key(
                    self.namespace,
                    op.key_type,
                    spec["id"],
                    op.use_case,
                    normalize_args(spec.get("args", {})),
                    op.tracked,
                )
        except Exception as error:
            self._error(op, "noop", "key_construction")
            self._log("Could not construct DialCache key: %s", error)
            return await self._source(op, "noop")
        try:
            overlay = await _await(self.policy_provider(key)) if self.policy_provider is not None else None
            policy = merge_policy(op.policy, overlay) or Policy()
        except Exception as error:
            self._error(key, "noop", "config_resolution")
            self._emit("disabled", self._labels(key, "noop"), reason="config_error")
            self._log("Could not resolve DialCache policy: %s", error)
            return await self._source(op, "noop")
        if not self.is_enabled():
            self._emit("disabled", self._labels(key, "noop"), reason="context")
            return await self._source(op, "noop")
        memo = self._context.request_cache() if policy.request_local is True else None
        if memo is None:
            return await self._shared(op, key, policy, "local")

        async def request() -> Any:
            start = self.clock.monotonic_ms()
            found, value = memo.read(key.logical)
            self._emit("request", self._labels(key, "request_local"))
            self._emit("get", self._labels(key, "request_local"), seconds=self._seconds(start))
            if found:
                return value
            self._emit("miss", self._labels(key, "request_local"), reason="value_absent")
            value = await self._shared(op, key, policy, "request_local")
            memo.set(key.logical, value)
            return value

        if policy.coalesce is False:
            return await request()
        return await self._single_flight(memo.in_flight, key, request, "request_local")

    async def _single_flight(
        self, table: dict[str, Any], key: Key, run: Callable[[], Awaitable[Any]], scope: str
    ) -> Any:
        existing = table.get(key.logical)
        if existing is not None:
            existing.followers += 1
            self._emit("coalesced", self._labels(key), scope=scope)
            return await asyncio.shield(existing.task)

        # Publish the result holder before scheduling the leader. Python's
        # eager task factory can run a complete cache hit inside create_task.
        # Followers (including reentrant observers) must already have a valid
        # result to join, and completion must never resurrect a settled flight.
        flight = _Flight(asyncio.get_running_loop().create_future(), self.clock.monotonic_ms())
        flight.task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        table[key.logical] = flight

        async def lead() -> Any:
            try:
                return await run()
            finally:
                if table.get(key.logical) is flight:
                    del table[key.logical]

        def transfer(done: asyncio.Task[Any]) -> None:
            if done.cancelled():
                flight.task.cancel()
            elif done.exception() is not None:
                flight.task.set_exception(done.exception())
            else:
                flight.task.set_result(done.result())

        self._spawn(lead()).add_done_callback(transfer)
        return await asyncio.shield(flight.task)

    def _layer(self, key: Key, policy: Policy, name: str) -> Any:
        layer = resolve_layer(policy, key.logical, name)
        if getattr(layer, "stale_on_error_config_error", False):
            self._error(key, name, "config_resolution")
        if not layer.enabled:
            self._emit("disabled", self._labels(key, name), reason=layer.reason)
            if layer.reason in ("invalid_ttl", "invalid_ramp"):
                self._error(key, name, "config_resolution")
        return layer

    async def _shared(self, op: _Operation, key: Key, policy: Policy, fallback_layer: str) -> Any:
        local = self._layer(key, policy, "local")
        if local.enabled:

            async def run() -> Any:
                start = self.clock.monotonic_ms()
                can_put = True
                try:
                    found, value = self._local.read(key.logical)
                    self._emit("request", self._labels(key, "local"))
                    self._emit("get", self._labels(key, "local"), seconds=self._seconds(start))
                    if found:
                        return value
                    self._emit("miss", self._labels(key, "local"), reason="value_absent")
                except Exception:
                    can_put = False
                    self._error(key, "local", "cache_read")
                    self._emit("disabled", self._labels(key, "local"), reason="config_error")
                return await self._lower(op, key, policy, local if can_put else None, "local")

            return (
                await run()
                if policy.coalesce is False
                else await self._single_flight(self._flights, key, run, "process")
            )
        if self.redis is None:
            return await self._source(op, fallback_layer)
        remote = self._layer(key, policy, "remote")
        if not remote.enabled:
            return await self._disabled_remote(op, key, policy, None, remote, fallback_layer)

        async def run_remote() -> Any:
            return await self._remote_chain(op, key, policy, None, remote)

        return (
            await run_remote()
            if policy.coalesce is False
            else await self._single_flight(self._flights, key, run_remote, "process")
        )

    async def _lower(self, op: _Operation, key: Key, policy: Policy, local: Any, fallback_layer: str) -> Any:
        if self.redis is None:
            value = await self._source(op, fallback_layer)
            self._put_local(key, value, local)
            return value
        remote = self._layer(key, policy, "remote")
        if not remote.enabled:
            return await self._disabled_remote(op, key, policy, local, remote, fallback_layer)
        return await self._remote_chain(op, key, policy, local, remote)

    async def _disabled_remote(
        self, op: _Operation, key: Key, policy: Policy, local: Any, remote: Any, fallback_layer: str
    ) -> Any:
        start = self.clock.monotonic_ms()
        source = self._spawn(self._source(op, fallback_layer))
        if remote.reason == "ramped_down":
            self._schedule_shadow(op, key, policy, remote, source=source, started=start)
        value = await asyncio.shield(source)
        self._put_local(key, value, local)
        return value

    def _put_local(self, key: Key, value: Any, local: Any) -> None:
        if local is not None:
            try:
                self._local.put(key.logical, value, local.ttl_sec)
            except Exception:
                self._error(key, "local", "cache_write")

    def _read_budget(self, policy: Policy) -> int:
        return (
            self.read_timeout_ms if policy.remote_read_timeout_ms is UNSET else policy.remote_read_timeout_ms
        )

    async def _raw_read(self, key: Key, policy: Policy, job: _Shadow | None = None) -> Frame | Miss:
        budget = self._read_budget(policy)
        signal = AbortSignal()

        async def invoke() -> Any:
            return await _await(
                self.redis.read(ReadRequest(key.value_key, key.watermark_key), ReadContext(budget, signal))
            )

        pending = self._spawn(invoke())
        if job is not None:
            job.pending_reads.add(pending)

            def finished(done: asyncio.Task[Any]) -> None:
                job.pending_reads.discard(done)
                self._release_shadow(key, job)

            pending.add_done_callback(finished)
        value = await self._deadline(
            pending, budget, lambda: RemoteReadTimeoutError(key.use_case, budget), on_timeout=signal.abort
        )
        if isinstance(value, Miss):
            fence = (
                value.observed_watermark_ms
                if key.tracked and _valid_integer(value.observed_watermark_ms)
                else None
            )
            reason = (
                value.reason
                if value.reason in ("value_absent", "expired", "watermark_fenced", "unclassified")
                else "unclassified"
            )
            if reason == "watermark_fenced" and fence is None:
                reason = "unclassified"
            return Miss(reason, fence)
        return value if isinstance(value, Frame) else Miss("unclassified")

    def _age(self, key: Key, frame: Frame, layer: str) -> float | None:
        if not _valid_integer(frame.created_at_ms):
            return None
        age = self.clock.wall_ms() - frame.created_at_ms
        if age < 0:
            self._emit("futureOffset", self._labels(key, layer), seconds=-age / 1000)
        return age

    async def _decode(self, op: _Operation, key: Key, payload: Any, layer: str) -> Any:
        decompressed = decompress_payload(payload)
        if decompressed.outcome != "passthrough":
            self._emit("compression", self._labels(key, layer), outcome=decompressed.outcome)
        start = self.clock.monotonic_ms()
        try:
            return await _await(op.serializer.load(decompressed.payload))
        except Exception:
            self._error(key, layer, "serialization_load")
            raise
        finally:
            self._emit(
                "serialization", self._labels(key, layer), operation="load", seconds=self._seconds(start)
            )

    async def _serving_read(
        self, op: _Operation, key: Key, policy: Policy, remote: Any
    ) -> tuple[str, Any, Any]:
        start = self.clock.monotonic_ms()
        labels = self._labels(key, "remote")
        self._emit("request", labels)
        try:
            try:
                read = await self._raw_read(key, policy)
            except Exception as error:
                self._error(
                    key,
                    "remote",
                    "cache_read_timeout" if isinstance(error, RemoteReadTimeoutError) else "cache_read",
                )
                return "error", None, None
            if isinstance(read, Miss):
                self._emit("miss", labels, reason=read.reason)
                return "miss", None, read.observed_watermark_ms
            age = self._age(key, read, "remote")
            maximum = remote.stale_on_error_max_age_sec or remote.ttl_sec
            if age is None or age < 0:
                self._emit("miss", labels, reason="unclassified")
                return "miss", None, None
            if age >= remote.ttl_sec * 1000:
                self._emit("miss", labels, reason="expired")
                return ("retained", read, None) if age < maximum * 1000 else ("miss", None, None)
            try:
                value = await self._decode(op, key, read.payload, "remote")
                return "hit", (value, read), None
            except Exception:
                self._emit("miss", labels, reason="unclassified")
                return "decode_error", None, None
        finally:
            self._emit("get", labels, seconds=self._seconds(start))

    async def _remote_chain(self, op: _Operation, key: Key, policy: Policy, local: Any, remote: Any) -> Any:
        status, acquired, fence = await self._serving_read(op, key, policy, remote)
        if status == "hit":
            value, frame = acquired
            self._put_local(key, value, local)
            self._schedule_shadow(op, key, policy, remote, frame=frame)
            return value
        try:
            value = await self._source(op, "remote")
        except Exception as error:
            maximum = remote.stale_on_error_max_age_sec
            if maximum and status in ("miss", "retained"):
                try:
                    allow = op.recovery(error)
                    if allow is True:
                        present, value = await self._recover(op, key, acquired, maximum)
                        if present:
                            return value
                    else:
                        self._discard_awaitable(allow)
                except Exception:
                    pass
            raise
        if status != "error":
            try:
                await self._write(op, key, value, remote, "remote", fence)
            except Exception:
                pass
        if not key.tracked:
            self._put_local(key, value, local)
        return value

    async def _recover(self, op: _Operation, key: Key, frame: Frame | None, maximum: int) -> tuple[bool, Any]:
        def record(outcome: str, age: float | None = None) -> None:
            self._emit("staleRecovery", self._labels(key), outcome=outcome)
            if age is not None:
                self._emit("recoveryAge", self._labels(key), outcome=outcome, seconds=age / 1000)

        age = self._age(key, frame, "remote") if frame is not None else None
        if age is None or age < 0 or age >= maximum * 1000:
            record("miss")
            return False, None
        try:
            value = await self._decode(op, key, frame.payload, "remote")
        except Exception:
            record("deserialization_error")
            return False, None
        age = self._age(key, frame, "remote")
        if age is None or age < 0 or age >= maximum * 1000:
            record("miss")
            return False, None
        record("served", age)
        return True, value

    async def _write(
        self,
        op: _Operation,
        key: Key,
        value: Any,
        remote: Any,
        layer: str,
        fence: int | None,
        live: Callable[[], bool] | None = None,
    ) -> bool:
        labels = self._labels(key, layer)
        if not key.tracked:
            fence = None
        if fence is not None and self.clock.wall_ms() <= fence:
            return False
        start = self.clock.monotonic_ms()
        try:
            payload = await _await(op.serializer.dump(value))
            if not isinstance(payload, (str, bytes)):
                raise TypeError("Serializer.dump must return str or bytes")
        except Exception:
            self._error(key, layer, "serialization_dump")
            raise
        finally:
            self._emit("serialization", labels, operation="dump", seconds=self._seconds(start))
        size = len(utf8_bytes(payload) if isinstance(payload, str) else payload)
        self._emit("size", labels, bytes=size)
        try:
            if self.compression is False:
                payload = escape_raw_payload(payload)
            else:
                options = self.compression if isinstance(self.compression, Mapping) else {}
                compressed = compress_payload(payload, **options)
                payload = compressed.payload
                self._emit("compression", labels, outcome=compressed.outcome)
        except Exception:
            self._error(key, layer, "compression")
            raise
        self._emit(
            "storedSize", labels, bytes=len(utf8_bytes(payload) if isinstance(payload, str) else payload)
        )
        if live is not None and not live():
            return False
        stamp = self.clock.wall_ms()
        if not _valid_integer(stamp):
            self._error(key, layer, "cache_write")
            raise ValueError("Invalid writer timestamp")
        if fence is not None and stamp <= fence:
            return False
        ttl_ms = (remote.stale_on_error_max_age_sec or remote.ttl_sec) * 1000
        if key.tracked and ttl_ms > 3_600_000:
            ttl_ms = 3_600_000
            self._error(key, layer, "tracked_ttl_clamped")
        try:
            await _await(self.redis.write(WriteRequest(key.value_key, ttl_ms, payload, stamp)))
        except Exception:
            self._error(key, layer, "cache_write")
            raise
        return True

    async def invalidate_remote(self, key_type: str, id: Any, future_buffer_ms: int = 0) -> None:
        """Write an entity fence after its source mutation commits; failures raise."""
        if not _valid_integer(future_buffer_ms, 0, 31_536_000_000):
            raise ConfigError("future_buffer_ms must be a nonnegative integer <= 31536000000")
        labels = {"cacheNamespace": self.namespace, "keyType": key_type, "layer": "remote"}
        self._emit("invalidation", labels)
        try:
            if self.redis is None:
                raise MissingRemoteError("invalidate_remote requires a configured Redis client")
            watermark = "{" + invalidation_prefix(self.namespace, key_type, id) + "}#watermark"
            await _await(
                self.redis.invalidate(InvalidationRequest(watermark, future_buffer_ms, self.clock.wall_ms()))
            )
        except Exception:
            self._emit("error", {**labels, "useCase": "watermark"}, error="invalidation", inFallback=False)
            raise

    ainvalidate = invalidate_remote

    def _schedule_shadow(
        self,
        op: _Operation,
        key: Key,
        policy: Policy,
        remote: Any,
        *,
        frame: Frame | None = None,
        source: asyncio.Task[Any] | None = None,
        started: float | None = None,
    ) -> None:
        shadow = policy.shadow
        if shadow is UNSET:
            return
        if not isinstance(shadow, Mapping):
            self._error(key, "remote", "config_resolution")
            return
        ramp = shadow.get("ramp", 0)
        if (
            not isinstance(ramp, (int, float))
            or isinstance(ramp, bool)
            or not math.isfinite(ramp)
            or not 0 <= ramp <= 100
        ):
            self._error(key, "remote", "config_resolution")
            return
        if ramp == 0 or self.metrics is None:
            return
        try:
            if hasattr(self.metrics, "supports") and not self.metrics.supports("shadowValidation"):
                return
        except Exception:
            return
        if ramp < 100 and ramp_sample(key, "shadow") >= ramp:
            return
        if key.logical in self._shadows or len(self._shadows) >= self._shadow_max:
            self._emit("shadowValidation", self._labels(key), outcome="dropped")
            return
        log = shadow.get("log_mismatches", shadow.get("logMismatches", False))
        if type(log) is not bool:
            self._error(key, "remote", "config_resolution")
            log = False
        job = _Shadow(self.clock.monotonic_ms() if started is None else started, op.timeout or 60_000)
        self._shadows[key.logical] = job
        self._spawn(self._run_shadow(op, key, policy, remote, job, frame, source, log))

    def _release_shadow(self, key: Key, job: _Shadow) -> None:
        if job.finished and not job.pending_reads and self._shadows.get(key.logical) is job:
            del self._shadows[key.logical]

    async def _shadow_read(self, key: Key, policy: Policy, maximum: int | None, job: _Shadow) -> Frame | Miss:
        labels = self._labels(key, "remote_shadow")
        start = self.clock.monotonic_ms()
        self._emit("request", labels)
        try:
            result = await self._raw_read(key, policy, job)
            if isinstance(result, Frame):
                age = self._age(key, result, "remote_shadow")
                if age is None or (age < 0 and maximum is not None):
                    result = Miss("unclassified")
                elif maximum is not None and age >= maximum * 1000:
                    result = Miss("expired")
            if isinstance(result, Miss):
                self._emit("miss", labels, reason=result.reason)
            return result
        except Exception as error:
            self._error(
                key,
                "remote_shadow",
                "cache_read_timeout" if isinstance(error, RemoteReadTimeoutError) else "cache_read",
            )
            raise
        finally:
            self._emit("get", labels, seconds=self._seconds(start))

    async def _run_shadow(
        self,
        op: _Operation,
        key: Key,
        policy: Policy,
        remote: Any,
        job: _Shadow,
        frame: Frame | None,
        source: asyncio.Task[Any] | None,
        log: bool,
    ) -> None:
        if source is None:
            job.started = self.clock.monotonic_ms()

        def abandon() -> None:
            nonlocal frame
            job.abandoned = True
            frame = None

        def live() -> bool:
            if self.clock.monotonic_ms() - job.started >= job.budget:
                abandon()
            return not job.abandoned

        details: dict[str, Any] = {}

        async def work() -> str:
            nonlocal frame
            try:
                if not live():
                    return "timeout"
                miss: Miss | None = None
                if source is not None:
                    try:
                        read = await self._shadow_read(key, policy, remote.ttl_sec, job)
                    except Exception:
                        return "redis_error"
                    if not live():
                        return "timeout"
                    if isinstance(read, Miss):
                        miss = read
                    else:
                        frame = read
                try:
                    if source is not None:
                        # This source belongs to the caller. A dark job stops
                        # waiting at its deadline without retaining capacity
                        # for an unbounded caller-owned operation.
                        value = await self._deadline(
                            source, job.budget, lambda: TimeoutError("shadow deadline"), started=job.started
                        )
                        await asyncio.sleep(0)
                    else:
                        with self.disable():
                            value = await _await(op.load())
                except Exception:
                    return (
                        "timeout" if not live() or (source is not None and op.did_timeout) else "source_error"
                    )
                if not live():
                    return "timeout"
                if miss is not None:
                    try:
                        filled = await self._write(
                            op, key, value, remote, "remote_shadow", miss.observed_watermark_ms, live
                        )
                        return ("filled" if filled else "fill_fenced") if live() else "timeout"
                    except Exception:
                        return "fill_error"
                if frame is None:
                    return "timeout"
                try:
                    cached = await self._decode(op, key, frame.payload, "remote_shadow")
                except Exception:
                    return "deserialization_error"
                if not live():
                    return "timeout"
                try:
                    matched = op.comparator(cached, value)
                    if type(matched) is not bool:
                        try:
                            await _await(matched)
                        except Exception:
                            pass
                        return "comparison_error" if live() else "timeout"
                except Exception:
                    return "comparison_error"
                if not live():
                    return "timeout"
                if not matched:
                    try:
                        confirmation = await self._shadow_read(key, policy, None, job)
                    except Exception:
                        return "confirmation_error"
                    if not live():
                        return "timeout"
                    if not isinstance(confirmation, Frame) or self._payload_bytes(
                        confirmation.payload
                    ) != self._payload_bytes(frame.payload):
                        return "superseded"
                    if log:
                        details.update(
                            cacheKey=self._clamp(key.logical, 2048),
                            cachedValueJson=self._preview(cached),
                            sourceValueJson=self._preview(value),
                        )
                details["age"] = max(0, self.clock.wall_ms() - frame.created_at_ms) / 1000
                return "match" if matched else "mismatch"
            finally:
                job.finished = True
                self._release_shadow(key, job)

        pending = self._spawn(work())
        try:
            outcome = await self._deadline(
                pending,
                job.budget,
                lambda: TimeoutError("shadow deadline"),
                started=job.started,
                on_timeout=abandon,
            )
        except Exception:
            outcome = "timeout"
        self._emit("shadowValidation", self._labels(key), outcome=outcome)
        if "age" in details and outcome in ("match", "mismatch"):
            self._emit("shadowAge", self._labels(key), outcome=outcome, seconds=details.pop("age"))
        if outcome == "mismatch" and log:
            self._emit("mismatchWarning", self._labels(key), outcome=outcome, **details)
            self._log("DialCache shadow validation mismatch: %s", {**self._labels(key), **details})

    @staticmethod
    def _payload_bytes(value: str | bytes) -> bytes:
        return utf8_bytes(value) if isinstance(value, str) else value

    @staticmethod
    def _clamp(text: str, limit: int) -> str:
        encoded = utf8_bytes(text)
        marker = b"...[truncated]"
        if len(encoded) <= limit:
            return text
        return encoded[: limit - len(marker)].decode("utf-8", "ignore") + marker.decode()

    @staticmethod
    def _preview(value: Any) -> str | None:
        try:
            text = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
            return DialCache._clamp(text, 8192)
        except Exception:
            return None
