"""Semantic Redis boundary and a resource-free adapter for redis.asyncio clients.

The application owns connections and finite socket/retry budgets. Cancellation
can stop a Python wait but cannot retract a dispatched Redis command. Writes
may have executed after a connection error. Invalidation retries the idempotent
script once with EVAL, preserving its original timestamp. This adapter never
connects, disconnects, flushes, or closes the borrowed client.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from .protocol import (
    ReadResult,
    RedisProtocolError,
    ceil_supported_cache_ttl_ms,
    decode_read,
    decode_tracked_read,
    encode_frame,
    validate_future_buffer_ms,
    validate_invalidation_reply,
    validate_set_reply,
    validate_timestamp,
)
from .serializer import Payload


@dataclass(frozen=True)
class ReadRequest:
    value_key: str
    watermark_key: str | None = None


class AbortSignal(Protocol):
    @property
    def aborted(self) -> bool: ...
    def add_callback(self, callback: Callable[[], Any]) -> None: ...


@dataclass(frozen=True)
class ReadContext:
    timeout_ms: float
    signal: AbortSignal | None = None


@dataclass(frozen=True)
class WriteRequest:
    value_key: str
    cache_ttl_ms: float
    value: Payload
    created_at_ms: int


@dataclass(frozen=True)
class InvalidationRequest:
    watermark_key: str
    future_buffer_ms: int
    invalidated_at_ms: int


class RedisClient(Protocol):
    def read(
        self, request: ReadRequest, context: ReadContext | None = None
    ) -> ReadResult | Awaitable[ReadResult]: ...
    def write(self, request: WriteRequest) -> None | Awaitable[None]: ...
    def invalidate(self, request: InvalidationRequest) -> None | Awaitable[None]: ...


# Same atomic transition as the TypeScript/Go/Rust adapters. Values never write
# watermarks. The clock sample belongs to one logical invalidation invocation.
INVALIDATE_CACHE_SCRIPT = """local function parse_safe_integer(raw)
  if not string.match(raw, "^%d+$") then
    return nil
  end
  local value = tonumber(raw)
  if not value or value > 9007199254740991 then
    return nil
  end
  return value
end

local future_buffer_ms = parse_safe_integer(ARGV[1])
if not future_buffer_ms or future_buffer_ms < 0 or future_buffer_ms > 31536000000 then
  return redis.error_reply("ERR invalid DialCache future buffer")
end
local invalidated_at_ms = parse_safe_integer(ARGV[2])
if not invalidated_at_ms or invalidated_at_ms > 9007199254740991 - future_buffer_ms then
  return redis.error_reply("ERR invalid DialCache invalidatedAtMs")
end

local proposed_watermark = invalidated_at_ms + future_buffer_ms
local raw_watermark = redis.pcall("GET", KEYS[1])
if type(raw_watermark) == "table" and raw_watermark.err then
  if not string.match(raw_watermark.err, "^WRONGTYPE ") then
    return raw_watermark
  end
  -- A wrong-type key cannot contain a valid watermark. Treat it as absent so
  -- the final SET repairs it, while preserving every other Redis error.
  raw_watermark = false
end
local current_watermark = 0

if raw_watermark then
  local parsed_watermark = parse_safe_integer(raw_watermark)
  if parsed_watermark then
    current_watermark = parsed_watermark
  end
end

local watermark = math.max(current_watermark, proposed_watermark)
local current_ttl_ms = -2
if raw_watermark then
  current_ttl_ms = redis.call("PTTL", KEYS[1])
end
local desired_ttl_ms = math.max(
  7200000,
  watermark - invalidated_at_ms + 3600000 + 60000
)
if current_ttl_ms > desired_ttl_ms then
  desired_ttl_ms = current_ttl_ms
end

local encoded_watermark = string.format("%.0f", watermark)
if current_ttl_ms == -1 then
  redis.call("SET", KEYS[1], encoded_watermark)
else
  redis.call("SET", KEYS[1], encoded_watermark, "PX", desired_ttl_ms)
end

return 1"""
INVALIDATE_CACHE_SCRIPT_SHA1 = hashlib.sha1(INVALIDATE_CACHE_SCRIPT.encode()).hexdigest()


class RedisAdapter:
    """Borrow a redis.asyncio.Redis or RedisCluster with decode_responses=False.

    Tracked Cluster reads require a client constructed for primary-only reads,
    with unchanged connection settings and no READONLY connection hook. A
    replica-configured client remains usable for untracked reads and mutations.
    Tracked MGET is one atomic snapshot, including through client redirects.
    ReadContext is informational; core owns its authoritative deadline.
    """

    def __init__(self, client: Any) -> None:
        self.client = client

    def _require_primary_connections(self) -> None:
        message = (
            "Tracked reads require a dedicated primary-only RedisCluster with unchanged connection settings"
        )
        try:
            configuration = self.client.get_connection_kwargs()
            safe = (
                not self.client.read_from_replicas
                and getattr(self.client, "load_balancing_strategy", None) is None
                and isinstance(configuration, Mapping)
                and configuration.get("redis_connect_func") is None
            )
        except Exception as error:
            raise RedisProtocolError(message) from error
        if not safe:
            raise RedisProtocolError(message)

    async def _command(self, key: str, *arguments: object, tracked_read: bool = False) -> Any:
        options: dict[str, object] = {}
        if hasattr(self.client, "get_node_from_key"):
            if tracked_read:
                self._require_primary_connections()
            # RedisCluster initializes its topology lazily. Explicit routing
            # must wait for that initialization before looking up the primary.
            await self.client.initialize()
            if tracked_read:
                # Replica routing affects redirects too. Constructor-installed
                # READONLY hooks survive flag changes and can serve a demoted
                # primary without any redirect; never borrow those connections.
                self._require_primary_connections()
            options["target_nodes"] = self.client.get_node_from_key(key, replica=False)
        return await self.client.execute_command(*arguments, **options)

    async def read(self, request: ReadRequest, context: ReadContext | None = None) -> ReadResult:
        if context is not None and context.signal is not None and context.signal.aborted:
            raise asyncio.CancelledError()
        if request.watermark_key is None:
            return decode_read(await self._command(request.value_key, "GET", request.value_key))
        result = await self._command(
            request.value_key, "MGET", request.value_key, request.watermark_key, tracked_read=True
        )
        if not isinstance(result, (list, tuple)) or len(result) != 2:
            raise RedisProtocolError("Invalid Redis MGET reply; expected two bulk strings")
        return decode_tracked_read(result[0], result[1])

    async def write(self, request: WriteRequest) -> None:
        ttl = ceil_supported_cache_ttl_ms(request.cache_ttl_ms)
        frame = encode_frame(request.value, request.created_at_ms)
        result = await self._command(request.value_key, "SET", request.value_key, frame, "PX", str(ttl))
        validate_set_reply(result)

    async def invalidate(self, request: InvalidationRequest) -> None:
        buffer = validate_future_buffer_ms(request.future_buffer_ms)
        timestamp = validate_timestamp(request.invalidated_at_ms)
        args = ("1", request.watermark_key, str(buffer), str(timestamp))
        try:
            result = await self._command(
                request.watermark_key, "EVALSHA", INVALIDATE_CACHE_SCRIPT_SHA1, *args
            )
        except Exception:  # noqa: BLE001 -- Any EVALSHA rejection gets one idempotent recovery.
            result = await self._command(request.watermark_key, "EVAL", INVALIDATE_CACHE_SCRIPT, *args)
        validate_invalidation_reply(result)
