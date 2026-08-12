# Redis and Valkey

[Back to the README](../README.md)

DialCache's remote TTL layer supports standalone Redis, standalone Valkey, and
Redis Cluster. The application creates, connects, configures, drains, and closes
the underlying client. DialCache borrows a client-independent
`DialCacheRedisClient` adapter and does not own the connection lifecycle.

Sampled non-serving Redis reads and fills use the same adapter and preserve the
operation's tracked or untracked mode. See
[Redis shadow validation](shadow-validation.md) for eligibility, comparison,
capacity, metrics, and rollout behavior.

## Install a client

Choose one supported integration:

```bash
# node-redis
npm install redis@~4.7.1

# or Valkey GLIDE
npm install @valkey/valkey-glide@^2.0.0
```

## node-redis

Register DialCache's two mutation scripts when creating the client, connect
it, and pass the DialCache-compatible adapter to `DialCache`:

```ts
import { createClient } from "redis";
import { DialCache } from "dialcache";
import {
  createNodeRedisDialCacheClient,
  dialcacheRedisScripts,
} from "dialcache/node-redis";

const redisClient = createClient({
  url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  scripts: dialcacheRedisScripts,
  disableOfflineQueue: true,
  commandsQueueMaxLength: 1_000,
  socket: { connectTimeout: 2_000 },
});

await redisClient.connect();

const dialcache = new DialCache({
  namespace: "users-api",
  redis: {
    client: createNodeRedisDialCacheClient(redisClient),
  },
});

async function shutdown(): Promise<void> {
  // Stop new work and await every cached call and invalidation first.
  await redisClient.quit();
}
```

`redis.client` is required when the remote layer is configured. Node-redis
users should register the supplied scripts and wrap the connected client with
`createNodeRedisDialCacheClient` as shown above. Active remote reads have a
50-millisecond DialCache deadline by default. Set `redis.readTimeoutMs` for an
instance-wide value or use `DialCacheKeyConfig.remoteReadTimeoutMs` for
per-use-case static and runtime policy.

Use node-redis's promise-mode client; `legacyMode` is not supported. Treat
`dialcacheRedisScripts` as adapter wiring rather than a direct write API. Its
`dialcacheWriteTrackedStamp` method returns the raw `0 | 1 | 2` script reply;
direct callers must pass that reply through `resolveTrackedRedisWriteReply`
from `dialcache/redis-protocol` so reply `2` becomes a lost-placeholder error.

Local-only caching does not require a Redis client, but the explicit remote
maintenance operation `invalidateRemote()` does. It rejects when Redis is not
configured so a caller cannot mistake an absent watermark write for successful
invalidation. See [Targeted invalidation](invalidation.md) for the complete
contract.

The registered scripts stamp tracked writes and advance invalidation
watermarks. Reads and untracked writes use native Redis commands. Node-redis
performs its normal script-cache recovery for the stamp script; the adapter's
additional invalidation recovery is described under
[Mutation retries and ambiguity](#mutation-retries-and-ambiguity).

Deployments using tracked invalidation must also satisfy the
[watermark durability](invalidation.md#watermark-durability) contract.

## Valkey GLIDE

Pass an already-created standalone or cluster client and the exact module
namespace that created it:

```ts
import * as valkeyGlide from "@valkey/valkey-glide";
import { DialCache } from "dialcache";
import { createValkeyGlideDialCacheClient } from "dialcache/valkey-glide";

const glideClient = await valkeyGlide.GlideClient.createClient({
  addresses: [{ host: "127.0.0.1", port: 6379 }],
  requestTimeout: 2_000,
  advancedConfiguration: {
    connectionTimeout: 2_000,
  },
});

const redisClient = createValkeyGlideDialCacheClient(
  glideClient,
  valkeyGlide,
);

const dialcache = new DialCache({
  namespace: "users-api",
  redis: { client: redisClient },
});

function shutdown(): void {
  // Drain cached calls and invalidations before releasing resources.
  glideClient.close();
}
```

DialCache uses the supplied namespace's `Batch`, `ClusterBatch`, client
constructors, and `Decoder.Bytes` value without importing a GLIDE runtime
itself. Passing the same module namespace that created the client prevents
linked workspaces or applications with another installed GLIDE version from
mixing native objects.

Pass a direct `GlideClient` or `GlideClusterClient` instance. Wrappers should
implement `DialCacheRedisClient` directly. The returned adapter is stateless,
owns no script handles, and needs no disposal; the application closes the
underlying GLIDE client after its work drains.

## Bundled Redis operations

The node-redis and GLIDE adapters preserve the same semantic protocol while
using each client's native command and routing APIs.

### Reads

- An untracked read is one native `GET`.
- A tracked read is one atomic `MGET valueKey watermarkKey`. Cluster adapters
  explicitly route it to the slot primary, even when replica reads are enabled,
  so replica lag cannot hide an invalidation watermark.
- Missing, short, unsupported-version, or placeholder frames are clean misses.
  A tracked read also misses when the watermark is missing or malformed, or
  when `createdAt <= watermark`.

The value and watermark must share a Redis Cluster slot; DialCache's generated
tracked keys do. Redis returns the complete value before the adapter compares
its timestamp with the watermark. A large invalidated value can therefore use
network bandwidth on every attempted read until a successful fallback write
removes it or its TTL expires. See
[Invalidated payload transfer and cleanup](invalidation.md#invalidated-payload-transfer-and-cleanup).

GLIDE standalone sends tracked `MGET` through a one-command non-atomic batch
so the client routes it to the primary instead of applying its ordinary
one-key read preference. `MGET` itself remains the single atomic snapshot; the
batch is deliberately non-transactional and does not consume caller-owned
`WATCH` state.

Node-redis standalone sends `MGET` to the endpoint the application configured;
the adapter cannot discover or reroute a standalone replica connection. Point
that client at the authoritative primary when relying on tracked invalidation.

DialCache keys must remain application-owned strings. Native Redis type rules
are intentionally visible: `GET` rejects a wrong-type untracked value, while
`MGET` returns a missing member for a wrong-type tracked value or watermark.
A wrong-type tracked value can be replaced by the fallback write when its
watermark is valid.

A wrong-type or malformed watermark makes reads miss, then causes the stamp to
fail after the placeholder `SET`; repeated calls therefore fail open and reload
until that watermark state is repaired. A valid-version frame with an
unsupported payload encoding is a typed payload error rather than a miss.

### Writes

An untracked write is one native command:

```text
SET valueKey frame PX cacheTtlMs
```

Its frame carries an informational client-clock timestamp. Untracked reads do
not consult that timestamp.

A tracked write uses two commands, ordered on one connection without
`MULTI`/`EXEC`:

1. `SET` writes the complete serialized payload in an unreadable version-0
   placeholder with a fresh nonce and the value TTL.
2. `WRITE_TRACKED_STAMP_SCRIPT` verifies that exact nonce, reads Redis time and
   the watermark, and either promotes the placeholder to a readable frame,
   unlinks it when the watermark fence is active, or reports that the
   placeholder was lost.

The nonce prevents a delayed stamp from publishing another writer's value.
The placeholder is a deliberate fail-safe: an interleaved or failed stamp is a
miss, not an unstamped cache hit. Because its `SET` replaces the prior frame, a
tracked write can briefly make a previously readable key miss while the stamp
settles.

The pair is non-transactional so it does not consume caller-owned Redis
`WATCH` state. The bundled adapters enqueue or batch the pair in order. A
watermark fence returns `false`; DialCache returns the fallback value and does
not publish it process-locally.

A missing, overwritten, or expired placeholder throws
`DialCacheRedisPlaceholderLostError`. Ordinary cached calls absorb that error
through the fail-open cache-write path, so same-key write contention can
produce benign bounded `cache_write` errors on hot keys.

The adapter reports a failed `SET` as the write outcome even if the stamp also
settled. Because transport failures can be ambiguous, the `SET` may have
landed and the stamp may have promoted it despite the reported error. Never use
a cache-write rejection as proof that Redis was not mutated.

### Mutation retries and ambiguity

The bundled adapters dispatch invalidation with `EVALSHA`. If dispatch rejects,
they retry once with the monotonic, replay-safe script source through `EVAL`;
this also repairs a flushed script cache. A reply-domain violation is a
protocol error, not a retryable dispatch failure. If recovery fails, the retry
error surfaces.

GLIDE attaches the original rejection as its `cause` when safe; node-redis does
not mutate the shared error objects it can use for disconnect failures.

For the tracked stamp, node-redis uses its registered script's normal
`NOSCRIPT` recovery. GLIDE retries the stamp with `EVAL` only on `NOSCRIPT`,
because any other error may be an ambiguous result from a stamp that already
executed. The first tracked GLIDE write after a script-cache flush can
therefore pay one extra round trip.

The retry is below the `DialCacheRedisClient` boundary. A successful recovery
is therefore not a DialCache error or retry metric, although Redis command
statistics can reveal the additional `EVAL`.

Like any network mutation, a rejected write or invalidation can have executed
before the client reports failure. Do not add an outer `Promise.race` and
assume rejection proves non-execution; use finite client-native queue,
reconnect, dispatch, and response budgets.

### Redis compatibility and ACLs

The tracked stamp uses `UNLINK`, so the bundled protocol requires Redis 4 or a
compatible Valkey release. Redis Cluster deployments must allow multi-key
operations for keys in the same slot.

At minimum, allow the client commands `GET`, `MGET`, `SET`, `EVALSHA`, and
`EVAL`. The scripts also invoke `TIME`, `GET`, `SET`, and `PTTL`; the tracked
stamp additionally invokes `PEXPIRE`, `UNLINK`, `GETRANGE`, and `SETRANGE`.
The bundled adapters do not require `SCRIPT LOAD`.

Verify ACLs and proxy behavior before upgrading. A persistent stamp failure
still lets each placeholder `SET` replace the last readable value, while the
failed write suppresses process-local publication. Within one value-TTL
horizon, affected tracked keys can send all traffic to the source. Each lost
placeholder on a DialCache request path also records a bounded `cache_write`
error and emits a warning; size alerts and logger rate limits for expected
same-key contention.

## Lifecycle ownership

The application owns the complete Redis lifecycle:

1. Create and connect the underlying client.
2. Construct the DialCache-compatible adapter.
3. Pass that adapter as `redis.client`.
4. During shutdown, stop starting DialCache-backed work.
5. Await every outstanding cached-function, `getOrLoad()`, and
   `invalidateRemote()` promise, including fallbacks that may still write
   Redis.
6. Drain or terminate client-native Redis work that may have outlived
   DialCache's caller-serving or shadow-read wait.
7. Close the underlying connection.

DialCache has no `close()` or drain method. It never disposes or closes caller
resources.

Awaiting public DialCache promises does not drain detached shadow work. Shadow
scheduling and deadline timers are unreferenced, and there is no shadow drain
handle.

A source read, serializer, Redis command, or metrics delivery started by a
shadow job can remain active during teardown. Stop new work before closing
dependencies and use their native drain or termination controls. An
already-dispatched shadow fill may have executed even if its outcome is lost.

Both bundled adapters are resource-free views over caller-owned clients. They
have no `dispose()` method and own no connection, batch, or script handle.
After DialCache and detached client work drain, close the underlying node-redis
or GLIDE client directly. A DialCache read timeout does not prove that the
client-side invocation has settled.

## Remote-read deadlines and async liveness

Every caller-serving Redis read and each detached shadow read has a finite
monotonic deadline. DialCache uses this precedence for `cached()` and
`getOrLoad()`:

```text
runtime remoteReadTimeoutMs
  -> defaultConfig.remoteReadTimeoutMs
  -> redis.readTimeoutMs
  -> 50 ms
```

Each explicit value must be a positive safe integer no greater than
2,147,483,647 milliseconds. Remote reads have no unbounded escape hatch.

Outside an enabled scope and on an earlier in-memory hit, DialCache creates no
remote-read timer. A key ramped out of Redis serving creates no caller-serving
timer, but an independently selected shadow job can create unreferenced timers
for its same-mode `C0` and optional `C1` reads.

### Caller-serving timeout and fail-open behavior

When the deadline expires, DialCache:

1. aborts the optional adapter signal;
2. logs a root-exported `RedisReadTimeoutError` carrying `useCase` and
   `timeoutMs`;
3. records `cache_read_timeout`;
4. consumes and ignores any late read fulfillment or rejection; and
5. runs the source fallback.

The deadline bounds caller wait and cache publication. It does not guarantee
server-side cancellation, and an event-loop-blocking operation cannot be
preempted. When control returns, DialCache still checks the monotonic deadline
before accepting the result.

A remote read rejection or timeout does not count as a miss and never triggers
a second Redis operation. After fallback, an untracked key may still populate
an active process-local cache. A tracked key suppresses process-local
publication because watermark safety was not established. Request-local
memoization remains unconditional.

Same-key callers in one request-local or process coalescing scope share the
leader's read, timer, and remaining budget. With `coalesce: false`, each caller
gets a full independent read budget and can start another remote read while a
prior client operation is still settling.

The `fallbackTimeoutMs` timer is separate and starts only if and when the source
loader begins. The remote-read timer covers neither config resolution,
serializer loading, the fallback, Redis writes, nor invalidation.

### Shadow-read deadlines

Shadow `C0` and `C1` reads use the same effective `remoteReadTimeoutMs` and
cooperative abort signal as caller-serving reads. Their timers are
unreferenced. A `C0` failure or read timeout produces `redis_error`; the same
failure at `C1` produces `confirmation_error`. Both paths also record the
ordinary bounded Redis error under `layer="remote_shadow"`.

The read deadline bounds DialCache's wait, not the underlying client
operation. Shadow capacity remains occupied while a timed-out raw Redis read
is still settling. The whole shadow job has a separate deadline described in
[Redis shadow validation](shadow-validation.md#capacity-deadlines-and-detachment).

### Custom-client contract

Custom adapters implement the complete client-independent read, write, and
invalidate contract:

```ts
import type {
  RedisCachePayload,
  RedisInvalidationRequest,
  RedisReadContext,
  RedisReadRequest,
  RedisWriteRequest,
} from "dialcache";

type Awaitable<T> = T | Promise<T>;

interface DialCacheRedisClientContract {
  read(
    request: RedisReadRequest,
    context?: RedisReadContext,
  ): Awaitable<RedisCachePayload | null>;
  write(request: RedisWriteRequest): Awaitable<boolean>;
  invalidate(request: RedisInvalidationRequest): Awaitable<void>;
}
```

#### `read`

- Decode native bulk-string replies with `decodeRedisFrame` or
  `decodeTrackedRedisFrame` from `dialcache/redis-protocol`, or preserve their
  exact behavior, and return the operation-owned serialized `string` or
  `Buffer`, or `null` for a miss.
- Keep the payload stable after settlement because DialCache can retain it for
  shadow work. An adapter that recycles response storage must return a
  dedicated `Buffer`.
- For a tracked request, obtain the value and watermark atomically from one
  authoritative primary snapshot. A missing or malformed watermark, or a
  value at or behind it, is a miss.

#### `write`

- Normalize `cacheTtlMs` with `ceilSupportedCacheTtlMs`; positive fractional
  milliseconds round up, and the result may not exceed `31_536_000_000`
  milliseconds (365 days).
- Use `encodeRedisFrame` for the one-command untracked path. For a tracked
  request, preserve the exact placeholder-and-stamp behavior described above
  with `encodeTrackedRedisPlaceholder`, `WRITE_TRACKED_STAMP_SCRIPT`, and
  `resolveTrackedRedisWriteReply`.
- On a non-fenced tracked write, create a missing baseline watermark and retain
  it for at least the value TTL plus one minute without shortening a longer or
  persistent lifetime.
- Return `true` only when the value was published and `false` only when the
  watermark fence rejected it. Surface a lost placeholder as
  `DialCacheRedisPlaceholderLostError`, not as `false`.

#### `invalidate`

- Accept `futureBufferMs` as a nonnegative integer no greater than
  `31_536_000_000` milliseconds (365 days).
- Advance `watermarkKey` monotonically to at least server time plus that buffer.
- Retain the watermark long enough to cover the buffer and any still-future
  existing watermark, plus one minute, without shortening a longer or
  persistent lifetime.
- Reject on failure.

`write()` returning `false` is a safe publication refusal, not an adapter error.
DialCache still returns the fallback value but skips the corresponding
process-local population. A thrown cache-write error fails open; a thrown
explicit invalidation error is rethrown to the caller.

The optional `RedisReadContext` keeps existing one-argument readers
structurally compatible. Adapters should use its signal for cooperative
cancellation where their client supports it, but the core deadline remains
authoritative when they do not.

The bundled node-redis adapter forwards the signal in per-command options. This
can remove queued work where supported, but aborting after dispatch cannot
unsend a command or prove that Redis stopped executing it.

The GLIDE command API has no per-invocation signal, so a timed-out command may
continue inside the adapter. Its configured
[`requestTimeout`](https://glide.valkey.io/languages/nodejs/api/interfaces/BaseClient.BaseClientConfiguration.html)
and
[`advancedConfiguration.connectionTimeout`](https://glide.valkey.io/languages/nodejs/api/interfaces/BaseClient.AdvancedBaseClientConfiguration.html)
still bound client-native work.

### Native operation budgets

DialCache's read deadline bounds its caller wait, not the complete lifetime of
the underlying client work. Configure finite client-native budgets for:

- connection establishment;
- reconnection and retries;
- offline queueing;
- dispatch; and
- response time.

For node-redis 4.7, `socket.connectTimeout`, `disableOfflineQueue`, and
`commandsQueueMaxLength` bound connection or queue behavior but do not impose a
strict response deadline after dispatch. Use client-native shutdown or
termination behavior that matches the application's resource and ambiguity
requirements.

Redis writes and invalidations, asynchronous `cacheConfigProvider` work, and
custom `Serializer` methods still require their own finite budgets. The same
is true for detached source, Redis, serializer, and telemetry work admitted by
shadow validation.

Do not put writes or invalidations behind a bare `Promise.race`: rejecting the
outer promise neither removes queued work nor proves that a dispatched
mutation did not execute.

DialCache's [fallback deadline](coalescing.md#fallback-deadlines) covers only the
source loader. Prefer resource-native budgets and cooperative cancellation for
every injected operation.

## Serialization

DialCache uses `JsonSerializer` by default. A cache operation can select a
typed serializer, and `redis.serializer` supplies the instance default when an
operation does not select one. Serializers run only for remote reads and
writes; request-local and process-local values remain native references.

### Default JSON behavior

DialCache uses native `JSON.stringify` and `JSON.parse` by default. There is no
runtime validation pass, so the default adds no traversal beyond JSON
serialization itself. A top-level `undefined` result is supported with an
internal sentinel.

When `serializer.load` rejects a Redis payload, DialCache:

1. records a `serialization_load` error;
2. counts the read as a remote miss;
3. runs the fallback; and
4. attempts to replace the rejected payload.

A validating custom serializer can therefore treat an incompatible cached
value as a refreshable miss without adding a schema version to the cache key.
This replacement behavior describes the caller-serving path. Shadow work
reports `deserialization_error` for a non-null payload and never repairs it.

`JsonSerializer` validates JSON syntax only. It cannot detect that a
structurally valid payload came from an incompatible application value schema.
Applications that retain one `useCase` across deployments must keep
default-JSON values backward compatible.

For an incompatible change, either:

- provide a serializer whose `load` method validates and rejects the old shape;
  or
- change `useCase` to isolate the new cache entries.

During a mixed deployment, mutually incompatible validating serializers can
repeatedly reject and replace each other's values. Correctness is preserved,
but expect additional fallback and Redis-write load until the rollout
converges.

### Typed serializer requirement

When a cached function or inline loader's resolved return type is statically
JSON-compatible, `serializer` is optional. This includes JSON primitives,
arrays, plain object or interface shapes, optional object fields, and a
top-level `undefined`.

Types known not to survive the default round trip require a typed
`Serializer<T>`:

```ts
import { DialCache, type Serializer } from "dialcache";

const dialcache = new DialCache();

const dateSerializer: Serializer<Date> = {
  dump: (value) => value.toISOString(),
  load: (value) =>
    new Date(Buffer.isBuffer(value) ? value.toString("utf8") : value),
};

const getUpdatedAt = dialcache.cached(
  (userId: string) => db.fetchUpdatedAt(userId),
  {
    keyType: "user_id",
    useCase: "GetUpdatedAt",
    cacheKey: (userId) => userId,
    serializer: dateSerializer,
  },
);
```

The compile-time guard rejects known incompatible shapes such as:

- `Date`, `Map`, and `Set`;
- `bigint`, symbols, and functions;
- Buffers and typed arrays;
- method-bearing class instances;
- required nested `undefined`; and
- `unknown` and `any`.

The guard applies to every `cached()` declaration and `getOrLoad()` invocation
because active layers are selected at runtime. A global Redis serializer is not
parameterized by each returned type, so it cannot discharge this requirement.
Non-JSON operations must select a typed serializer.

This guard is deliberately conservative rather than a proof of runtime data.
TypeScript cannot detect non-finite numbers, cyclic or shared references,
runtime getters, `toJSON` behavior, or data-only class instances that resemble
plain objects. Opaque, generic, or deeply recursive types may also require an
explicit serializer.

Providing `Serializer<T>`, including an explicitly typed
`JsonSerializer<T>`, is a trusted caller assertion. DialCache does not perform
an additional serialize-and-deserialize cycle to validate it.

Opted-in confirmed-mismatch logging is separate from cache serialization. It
uses native `JSON.stringify` on the deserialized cached snapshot and source
value and does not call the configured serializer again. Its byte caps are not
redaction; review the data-handling contract in
[Redis shadow validation](shadow-validation.md) before enabling it.

Shadow validation can call `load` again for the same served payload and can
call `dump` after a ramped-down caller has received its source result. Custom
serializers must treat payloads and values as borrowed and immutable, return
independent values from repeated loads, and copy a Buffer before mutating it.
See [Data ownership and custom integrations](shadow-validation.md#data-ownership-and-custom-integrations).

## Compression

Redis payload compression is enabled by default and configured once per
`DialCache` instance:

```ts
const dialcache = new DialCache({
  redis: {
    client: dialCacheRedisClient,
    compression: {
      thresholdBytes: 4_096,
      level: 3,
    },
  },
});
```

`thresholdBytes` must be a positive safe integer and defaults to 4,096 bytes.
`level` must be an integer from 1 through 22 and defaults to 3. Pass
`compression: false` to disable compression on future writes. This is an
instance-level write policy, not a per-use-case runtime ramp.

DialCache measures the serializer output in bytes, then compresses it with
zstd only when it meets the threshold and the marked compressed form is
smaller than the raw stored form. Compression and decompression are
synchronous and run on the Node.js event loop. Benchmark representative value
sizes and zstd levels under production-like concurrency before lowering the
threshold or raising the level.

Default-on compression requires zstd-capable `node:zlib`; DialCache validates
that support during construction. The package's supported Node.js range starts
at 22.15.0 in the 22.x line and excludes 23.0 through 23.7. The exact published
engine range is `>=22.15.0 <23.0.0 || >=23.8.0`.

Reads always decode marked payloads, even when write-side compression is
disabled. That makes `compression: false` a safe way to stop producing new
compressed entries without orphaning existing ones. Binary serializer output
whose first byte is `0x00`, `0x01`, or `0x02` is also escaped on every write,
including when compression is disabled, so current readers can distinguish it
from the compression envelope exactly.

### Size limits and failure behavior

DialCache caps decompressed output at 512 MiB, matching Redis's value limit.
Serializer output above that cap is left raw for the Redis write rather than
compressed.

If a marked value cannot be decompressed or would exceed the cap, DialCache
passes the original marked bytes to `serializer.load`; a validating serializer
will normally reject it and trigger the existing self-healing miss path. A
permissive custom serializer can instead accept those bytes, so monitor
`fallback_raw` and `read_over_limit` as payload-integrity signals rather than
assuming they always become misses.

A write-side zstd exception records `error="compression"`, skips the Redis
write, and follows DialCache's fail-open cache-write path. The fallback result
still returns. Decompression outcomes are reported before serializer loading;
if loading then fails, the same read can also record `serialization_load`.

Compression-aware metrics adapters can implement the optional `compression`,
`observeStoredSize`, `observeCompressionRatio`, and `observeCompression`
hooks. `observeSize` remains the serializer-output size before compression or
escaping; `observeStoredSize` measures the prepared payload afterward, before
the shadow deadline gate and Redis write. It does not prove that a write was
dispatched or succeeded. See
[Observability](observability.md#compression-metrics) for bounded outcomes and
the bundled Prometheus and Datadog metric names.

### Rolling deployments and binary serializers

Current readers accept frames from older releases. Older readers, however, do
not understand newly compressed or escaped payloads and will usually reject
them during deserialization, causing temporary fallback and refill churn in a
mixed deployment. For string and JSON serializers, a low-noise rollout is:

1. deploy the new release everywhere with `compression: false`;
2. allow old readers to drain; and
3. enable compression in a later rollout.

Apply the same consideration when rolling back while compressed entries still
exist.

Before the escape envelope existed, arbitrary binary output could already
begin with an envelope marker. A legacy payload beginning with `0x00` followed
by `0x00`–`0x02`, or with `0x01`/`0x02` followed by a valid zstd stream, can be
misinterpreted by a current reader until it expires. If a custom serializer
can emit those prefixes, change the operation's `useCase` or other key-version
component for the migration.

## Advanced wire protocol

The core Redis boundary is the client-independent `DialCacheRedisClient`
interface. It exchanges serialized values as `string | Buffer` and does not
expose client-specific commands or wire encodings.

The `dialcache/redis-protocol` entry point exports the exact bundled protocol
building blocks:

- `decodeRedisFrame` and `decodeTrackedRedisFrame` for native read replies;
- `encodeRedisFrame`, `encodeTrackedRedisPlaceholder`, and the
  `TrackedRedisPlaceholder` type for native writes;
- `ceilSupportedCacheTtlMs` for adapter-level write TTLs;
- `WRITE_TRACKED_STAMP_SCRIPT` and `INVALIDATE_CACHE_SCRIPT`;
- `resolveTrackedRedisWriteReply`; and
- `validateRedisSetReply` and `validateRedisScriptInvalidationReply`.

The payload bytes inside the Redis frame are opaque to this adapter-level
protocol. Compression and escaping sit above it in DialCache core. Custom
adapters must preserve those bytes exactly and must not decompress or rewrite
them.

Custom adapters can throw these root-exported error classes:

- `DialCacheRedisPayloadError`;
- `DialCacheRedisPayloadEncodingError`;
- `DialCacheRedisProtocolError`; and
- `DialCacheRedisPlaceholderLostError`.

They distinguish invalid runtime payload or reply shapes, unsupported
encodings, and lost tracked placeholders. DialCache records bounded
`cache_read`, `cache_read_timeout`, `cache_write`, or `invalidation` metrics by
failure site.

Shadow validation adds no Redis protocol operation. It composes the ordinary
request shapes for the operation: `C0`, `C1`, and any clean-miss fill remain
tracked or untracked together.

### Binary frame

Redis values use a compact binary frame:

```text
byte 1      format version
bytes 2-9   creation timestamp or placeholder nonce (eight-byte region)
byte 10     payload encoding (0 = UTF-8, 1 = raw binary)
bytes 11... opaque post-serialization payload
```

Version 1 is readable. A tracked placeholder uses version 0 and stores its
eight-byte nonce in the stamp region, so neither read path can serve it. The
stamp script promotes only its matching placeholder by replacing version and
nonce with version 1 and Redis time.

An untracked frame is version 1 from the start and carries an informational
client-clock timestamp that untracked reads ignore. Redis TTL is authoritative,
so expiry metadata is not duplicated in the frame.

The payload region contains the serializer output after any compression or raw
binary escaping. The frame encoding preserves whether that region is a string
or `Buffer`; strings use UTF-8 and Buffers need no base64 expansion. After the
adapter decodes the frame, DialCache interprets the optional compression
envelope and restores the serializer's representation before calling
`serializer.load`.
