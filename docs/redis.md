# Redis and Valkey

[Back to the README](../README.md)

DialCache's remote TTL layer supports standalone Redis, standalone Valkey, and
Redis Cluster. The application creates, connects, configures, drains, and closes
the underlying client. DialCache borrows a semantic `DialCacheRedisClient` and
does not own the connection lifecycle.

## Install a client

Choose one supported integration:

```bash
# node-redis
npm install redis@~4.7.1

# or Valkey GLIDE
npm install @valkey/valkey-glide
```

## node-redis

Register DialCache's native scripts when creating the client, connect it, and
pass the semantic adapter to `DialCache`:

```ts
import { createClient } from "redis";
import { DialCache } from "dialcache";
import {
  createNodeRedisDialCacheClient,
  dialcacheRedisScripts,
} from "dialcache/node-redis";

const redisClient = createClient({
  url: process.env.REDIS_URL,
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

The adapter computes each script's SHA, uses `EVALSHA`, and retries with `EVAL`
after `NOSCRIPT`. Its cluster client routes scripts by their first key and
performs that fallback on the selected shard. Tracked reads are deliberately
routed to primaries so a lagging replica cannot hide an invalidation watermark.

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
  redisClient.dispose();
  glideClient.close();
}
```

DialCache uses the supplied namespace's `Script` constructor and
`Decoder.Bytes` value without importing a GLIDE runtime itself. Passing the same
module namespace that created the client prevents linked workspaces or
applications with another installed GLIDE version from mixing native script
handles.

The GLIDE adapter uses GLIDE's native script lifecycle and byte decoder. GLIDE
routes scripts from their declared keys.

## Lifecycle ownership

The application owns the complete Redis lifecycle:

1. Create and connect the underlying client.
2. Construct the semantic DialCache adapter.
3. Pass that adapter as `redis.client`.
4. During shutdown, stop starting DialCache-backed work.
5. Await every outstanding cached-function, `getOrLoad()`, and
   `invalidateRemote()` promise, including fallbacks that may still write
   Redis.
6. Drain or terminate client-native Redis work that may have outlived
   DialCache's remote-read wait.
7. Dispose adapter-owned resources.
8. Close the underlying connection.

DialCache has no `close()` or drain method. It never disposes or closes caller
resources.

The node-redis adapter owns no additional resources, so close the underlying
client after draining work.

The GLIDE adapter owns five native `Script` handles but not the wrapped
connection. Call its idempotent `dispose()` after operations finish and before
closing GLIDE. Disposing while an adapter operation is in flight throws rather
than releasing a live script. A DialCache read timeout does not prove that the
client-side invocation has settled.

## Remote-read deadlines and async liveness

Every active semantic remote-read leader has a finite monotonic deadline.
DialCache uses this precedence for `cached()` and `getOrLoad()`:

```text
runtime remoteReadTimeoutMs
  -> defaultConfig.remoteReadTimeoutMs
  -> redis.readTimeoutMs
  -> 50 ms
```

Each explicit value must be a positive safe integer no greater than
2,147,483,647 milliseconds. Remote reads have no unbounded escape hatch.
Outside an enabled scope, on a local hit, or when remote policy is disabled or
ramped out, DialCache creates no remote-read timer.

### Timeout and fail-open behavior

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
leader's read, timer, and remaining budget. A later independent invocation may
start a new remote read even if the prior client operation is still settling.

The `fallbackTimeoutMs` timer is separate and starts only if and when the source
loader begins. The remote-read timer covers neither config resolution,
serializer loading, the fallback, Redis writes, nor invalidation.

### Custom-client contract

Custom adapters implement the complete client-agnostic semantic boundary:

```ts
interface RedisReadContext {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

interface DialCacheRedisClient {
  read(
    request: RedisReadRequest,
    context?: RedisReadContext,
  ): Awaitable<RedisCachePayload | null>;
  write(request: RedisWriteRequest): Awaitable<boolean>;
  invalidate(request: RedisInvalidationRequest): Awaitable<void>;
}
```

| Method | Required semantics |
| --- | --- |
| `read` | Return the serialized `string` or `Buffer`, or `null` for a miss. A tracked request includes `watermarkKey`; compare the value timestamp and watermark atomically. |
| `write` | Apply `cacheTtlMs` and record server time atomically. A tracked request includes `watermarkKey`; return `false` when the watermark rejects publication and `true` when the value was written. |
| `invalidate` | Advance `watermarkKey` monotonically to at least server time plus `futureBufferMs`, while preserving the required derived lifetime. Reject on failure. |

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

The GLIDE script API has no per-invocation signal, so a timed-out script
invocation may continue inside the adapter. Its configured
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
custom `Serializer` methods still require their own finite budgets. Do not put
writes or invalidations behind a bare `Promise.race`: rejecting the outer
promise neither removes queued work nor proves that a dispatched mutation did
not execute.

DialCache's [fallback deadline](coalescing.md#fallback-deadlines) covers only the
source loader. Prefer resource-native budgets and cooperative cancellation for
every injected operation.

## Serialization

The core Redis boundary is the client-agnostic `DialCacheRedisClient` interface.
It exchanges serialized values as `string | Buffer` and does not expose
client-specific commands or wire encodings.

The `dialcache/redis-protocol` entry point exports the exact bundled protocol
building blocks:

- `READ_CACHE_SCRIPT` and `READ_TRACKED_CACHE_SCRIPT`;
- `WRITE_CACHE_SCRIPT` and `WRITE_TRACKED_CACHE_SCRIPT`;
- `INVALIDATE_CACHE_SCRIPT`; and
- `REDIS_FRAME_VERSION`, `REDIS_ENCODING_UTF8`, and
  `REDIS_ENCODING_BINARY`.

The scripts implement the atomic read, publication, invalidation, server-time,
and derived-watermark-lifetime behavior required above. Custom adapters can
throw these root-exported error classes:

- `DialCacheRedisPayloadError`;
- `DialCacheRedisPayloadEncodingError`; and
- `DialCacheRedisProtocolError`.

They distinguish malformed payloads, unsupported encodings, and invalid Lua
reply domains in logs. DialCache records bounded `cache_read`,
`cache_read_timeout`, `cache_write`, or `invalidation` metrics by failure site.

### Binary frame

Redis values use a compact binary frame:

```text
byte 1      format version
bytes 2-9   Redis-created timestamp in milliseconds (uint64, big-endian)
byte 10     payload encoding (0 = UTF-8, 1 = raw binary)
bytes 11... serialized payload
```

Redis's Lua `struct` library packs and unpacks the timestamp. Redis TTL is
authoritative, so expiry metadata is not duplicated in the frame.

The payload comes from the cache operation's serializer or `JsonSerializer` by
default. Custom serializers can return `string` or `Buffer`. Strings are
stored as UTF-8; Buffers are stored byte-for-byte without base64 expansion.
Adapters restore the same representation before calling `serializer.load`.

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
