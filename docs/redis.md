# Redis and Valkey

[Documentation](index.md) · [API reference](api.md)

The remote layer shares cached reads across application instances. DialCache
owns cache behavior; your application owns the connected Redis client, its
resource budgets, and shutdown. Use a bundled native adapter or implement the selected port's semantic
remote interface for another client.

Start with a client below, then choose [serialization](#serialization) and
[compression](#compression). The [command reference](#bundled-redis-operations)
and [wire protocol](#advanced-wire-protocol) cover adapter and operational details.

## Install a client

Configuring a client makes the remote layer available. Every reader still needs
an enabled scope, a valid remote TTL and an admitted serving ramp. Applications
own connections, retries, queue limits and shutdown.

<LanguageContent language="typescript">

<a id="typescript-clients"></a>

**TypeScript clients**

```bash
# node-redis
npm install redis@~4.7.1

# or Valkey GLIDE
npm install @valkey/valkey-glide@^2.0.0
```

Configuring a client makes the remote layer available. Each operation still
needs an effective remote TTL, an admitted serving ramp, and an enabled scope.
See [Configuration](configuration.md#baseline-and-overlay-precedence).

<a id="node-redis"></a>

**node-redis**

This API excerpt creates and connects the client before wrapping it:

```ts
import { createClient } from "redis";
import { DialCache } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";

const redisClient = createClient({
  url: process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
  disableOfflineQueue: true,
  commandsQueueMaxLength: 1_000,
  socket: { connectTimeout: 2_000 },
});
redisClient.on("error", (error) => console.error("Redis client error", error));
await redisClient.connect();

const dialcache = new DialCache({
  namespace: "users-api",
  redis: {
    client: createNodeRedisDialCacheClient(redisClient),
    readTimeoutMs: 100, // Optional; the library default is 50 ms.
  },
});
```

The helper accepts the promise-based node-redis client, including its Cluster
client. It requires binary command replies and does not support `legacyMode`.
It manages invalidation script dispatch internally; no caller-side script
registration is needed. Tracked Cluster reads route to the slot primary.

These connection options are examples, not a complete operation budget. Bound
queueing, retries, reconnects, and command settlement for your application.

<a id="valkey-glide"></a>

**Valkey GLIDE**

This API excerpt passes the direct standalone or Cluster client and the same
module namespace that created it:

```ts
import * as valkeyGlide from "@valkey/valkey-glide";
import { DialCache } from "dialcache";
import { createValkeyGlideDialCacheClient } from "dialcache/valkey-glide";

const glideClient = await valkeyGlide.GlideClient.createClient({
  addresses: [{ host: "127.0.0.1", port: 6379 }],
  requestTimeout: 2_000,
  advancedConfiguration: { connectionTimeout: 2_000 },
});

const dialcache = new DialCache({
  namespace: "users-api",
  redis: {
    client: createValkeyGlideDialCacheClient(glideClient, valkeyGlide),
  },
});
```

The adapter uses `GlideClient` and `GlideClusterClient` identities, `Batch`, and
`Decoder.Bytes` from that namespace. It does not import its own GLIDE runtime.
It rejects ambiguous forwarding wrappers or clients from another module
instance because their topology cannot be established safely.

In Cluster mode, tracked `MGET` uses an explicit primary route. In standalone
mode, a one-command non-atomic batch selects the primary even when the client
has a replica-read preference. `MGET` itself supplies the atomic snapshot;
there is no transaction and caller-owned `WATCH` state is not consumed.
`ClusterBatch` is not required.

</LanguageContent>

<LanguageContent language="go">

The bundled `RedisAdapter` supports go-redis standalone, Sentinel and Cluster
clients. Install the module; go-redis is part of its dependency graph:

```bash
go get github.com/lan17/DialCache/go@latest
```

Create the appropriate `redis.UniversalClient` in your application, then pass
`dialcache.NewRedisAdapter(client)` to `dialcache.WithRemote`. Tracked reads
select the primary even if the client permits replica reads. Set connection,
read/write and retry budgets on the native client; close it only after application
work is drained. The [executed invalidation example](invalidation.md#configure-a-tracked-use-case)
links to complete connection setup.

</LanguageContent>

<LanguageContent language="rust">

Enable DialCache's `redis` feature and add the Redis client to the application:

```toml
[dependencies]
dialcache = { path = "../DialCache/rust", features = ["redis"] }
redis = { version = "1", features = ["tokio-comp", "connection-manager"] }
```

The path points to a checkout because the crate is unpublished. `RedisAdapter`
implements `Remote` for connection managers, multiplexed connections and Cluster
connections. Pass an adapter through the cache builder's `remote` method.
Tracked reads route to slot primaries. The complete
[Redis example](https://github.com/lan17/DialCache/blob/main/rust/examples/redis.rs)
configures client connection and command timeouts:

```bash
cd rust
REDIS_URL=redis://127.0.0.1/ cargo run --features redis --example redis
```

The [executed invalidation example](invalidation.md#configure-a-tracked-use-case)
shows the reader and maintenance call; the complete source includes connection
setup and cleanup.

</LanguageContent>

## Remote-read deadlines and async liveness

The read deadline resolves from the runtime overlay, operation defaults, instance
setting, then the library default of 50 ms. It accepts positive whole milliseconds
up to 2,147,483,647 and cannot be unbounded.

When that wait expires, DialCache records `cache_read_timeout` and invokes the
source. Late outcomes are ignored. A read error or timeout does not trigger a
Redis refill or stale recovery. An active untracked local layer may store the
successful source result; a tracked path suppresses that publication.

The deadline covers the semantic read, not configuration, deserialization,
source work, writes, or invalidation. Coalesced followers share the leader's
remaining budget. The source deadline begins separately when fallback starts.
Recovery reuses the initial snapshot and creates no second read budget.

<LanguageContent language="typescript">

Node-redis receives `RedisReadContext.signal` for cooperative cancellation where
supported; GLIDE uses its configured native request budget. Read timeouts log
`RedisReadTimeoutError`. Neither adapter promises server-side cancellation.

</LanguageContent>

<LanguageContent language="go">

The adapter receives a bounded `context.Context`; native reads can observe
cancellation. The cache's `RemoteReadTimeoutError` does not prove a dispatched
Redis command stopped or free the application from bounding retries and queues.

</LanguageContent>

<LanguageContent language="rust">

The adapter applies its native read budget, while the async engine bounds its
own wait. A dropped or timed-out future does not establish server-side
cancellation. Keep native connection and command budgets finite.

</LanguageContent>

See [Coalescing and liveness](coalescing.md).

## Lifecycle ownership

Before shutdown, stop new work and await cache operations and invalidation,
including loaders that may later write Redis. A read DialCache stopped waiting
for may still be active in the client. Drain or terminate that work using native
client controls before closing connections.

<LanguageContent language="typescript">

Close node-redis with `await redisClient.quit()` or GLIDE with
`glideClient.close()` after draining work. The adapters own no additional
resources. Shadow scheduling and deadlines are unreferenced and do not keep
Node alive.

</LanguageContent>

<LanguageContent language="go">

Close the application-owned go-redis client after draining cache, source and
maintenance work. Cache read deadlines do not cancel independently running
source goroutines; use native contexts for that work.

</LanguageContent>

<LanguageContent language="rust">

Keep the captured Tokio runtime alive while cache operations and native client
work settle. Dropping a caller future is not a cache drain. Close or drop the
application's connection owners only after draining dependent work.

</LanguageContent>

Detached shadow work has no public drain handle. Already-started Redis, source,
codec or telemetry work may outlive its shadow deadline. Account for it when
closing dependencies; shutdown can lose a best-effort outcome even if a fill
was dispatched.

## Serialization

In-memory caches retain native values without serialization. Redis requires a
codec that preserves the application's value meaning, including empty and
null-like values. A codec's successful parse need not validate the application's
schema; validate incompatible shapes or change a key dimension such as use case.

<a id="typed-serializer-requirement"></a>

### Default JSON behavior

<LanguageContent language="typescript">

Redis serialization precedence is operation `serializer`, then instance
`redis.serializer`, then `JsonSerializer`. In-memory caches retain native
references and do not serialize them.

`JsonSerializer` uses native JSON semantics and supports top-level `undefined`
through a private marker. Redis hits containing `null`, `false`, `0`, `""`, or
`undefined` are still hits.

JSON does not preserve every JavaScript value. Nested object `undefined` can
be omitted; undefined array elements and non-finite numbers can become `null`.
Dates lose their type, maps and sets lose their structure, and bigint or cycles
can fail serialization. Reference sharing and prototypes are not preserved.

Direct `JsonSerializer.dump(value)` calls return `Promise<string>`;
`load(string | Buffer)` returns `Promise<T>`, decoding Buffer input as UTF-8.
Malformed JSON rejects with `SyntaxError`. After handling top-level `undefined`,
`dump` rejects with `Error` when `JSON.stringify` returns undefined, as it does
for ordinary top-level functions or symbols. Bigint and cycles normally reject
with native `TypeError`. The generic `T` is a caller assertion, not schema
validation.

**Typed serializer requirement.**

The public types require a `Serializer<T>` when the result is not statically
JSON-compatible, even if the current policy uses only local memory. Runtime
policy can activate Redis later.

This API excerpt supplies a typed date codec:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig, type Serializer } from "dialcache";

const dialcache = new DialCache();
const dateSerializer: Serializer<Date> = {
  dump: (value) => value.toISOString(),
  load: (value) => new Date(Buffer.isBuffer(value) ? value.toString("utf8") : value),
};

const getUpdatedAt = dialcache.cached(
  async (userId: string) => new Date("2026-01-01T00:00:00Z"),
  {
    keyType: "user_id",
    useCase: "GetUpdatedAt",
    cacheKey: (userId) => userId,
    serializer: dateSerializer,
    defaultConfig: new DialCacheKeyConfig({ ttlSec: { [CacheLayer.LOCAL]: 60 } }),
  },
);
```

`dump` produces `string | Buffer`; `load` receives that payload and returns the
value. Both may be asynchronous. Give them finite application-owned budgets.
A global `Serializer<unknown>` cannot satisfy a particular operation's typed
requirement.

The guard rejects known incompatible shapes including `Date`, `Map`, `Set`,
bigint, functions, symbols, Buffers, typed arrays, method-bearing classes,
required nested undefined, `unknown`, and `any`. It is conservative and cannot
prove runtime data has no cycles, non-finite numbers, getters, or `toJSON` hooks.
The structural check stops at eight property/array-element steps, so deeply
nested or recursive JSON types can also require a serializer. When ordinary JSON
correctly round-trips those values, supply an explicit `new JsonSerializer<T>()`.
Supplying a typed serializer is a trusted assertion, not an extra round-trip
validation performed by DialCache.

</LanguageContent>

<LanguageContent language="go">

`JSONCodec[T]` is the default. A per-operation `Codec[T]`, optionally implementing
`ContextCodec[T]`, replaces it. Typed destinations obey Go field/tag and numeric
range rules; use `any` for the broader supported JSON domain.

Nil represents JSON null and `Absent` represents the TypeScript undefined
sentinel. Values such as false, zero and empty text remain hits. Unpaired UTF-16
surrogate escapes are rejected. `JSONObject` preserves insertion order when
byte identity matters; ordinary maps use deterministic UTF-16 ordering.
Decoders must return independently usable values. See the
[Go guide](languages/go.md#identity-and-values) and [API reference](api.md).

Use an explicit `Codec[T]` when the default cannot preserve the value domain.
Runtime policy may enable remote storage later, so choose the codec when defining
the operation, even if its first rollout uses only memory layers.

</LanguageContent>

<LanguageContent language="rust">

`JsonCodec` uses serde_json. Supply an async `Codec<T>` for other value domains;
`FromSync` adapts a synchronous codec without moving its work to another thread.
Rust maps the TypeScript undefined sentinel to JSON null (`None` for suitable
`Option<T>` types) and accepts Unicode scalar strings, not unpaired UTF-16
surrogates. Ensure schemas agree before sharing entries with another language.

`Operation::with_codec` supports values outside the default serde JSON domain.
The engine passes an owned `Arc<T>` to `Codec::encode_owned`; overriding it can
schedule CPU work without copying a non-Clone value. Custom codecs own the
budgets and lifetime of work they start. See the
[Rust guide](languages/rust.md#identity-and-values) and [API reference](api.md).

</LanguageContent>

A fresh frame whose `load` fails becomes a refreshable miss: DialCache records
`serialization_load`, calls the source, and attempts replacement. The default
codec validates JSON syntax, not your application schema. For incompatible
value changes, use a validating serializer or change an identity dimension such
as `useCase`. Mixed incompatible readers can repeatedly replace one another's
values until a deployment converges.

A non-null shadow payload that fails deserialization is observation-only and
is never repaired. A retained recovery candidate that fails deserialization
preserves the original source rejection.

## Compression

Compression runs between the codec and Redis adapter. It is on by default with
a 4,096-byte threshold and zstd level 3. This is instance policy, not a runtime
overlay. Thresholds are positive integers and levels range from 1 to 22.

<LanguageContent language="typescript">

Configure `redis.compression: { thresholdBytes, level }` on the instance.
`compression: false` disables compressed writes. Invalid options throw during
construction.

</LanguageContent>

<LanguageContent language="go">

Use `WithCompression(CompressionConfig{...})` or `WithoutCompression()`.
Zero fields in the native compression config keep the default threshold and
level; invalid values return constructor errors.

</LanguageContent>

<LanguageContent language="rust">

Use the builder's `compression` method or `disable_compression`.
Invalid settings return `ConfigError` at build time.

</LanguageContent>

Payloads meeting the threshold are compressed with zstd only when the stored
form is smaller. Reads always interpret the compression envelope, including
when new-write compression is disabled. Binary payloads beginning with an
envelope marker are escaped even in that disabled mode.

<LanguageContent language="typescript">

Compression and decompression run synchronously on the JavaScript event loop.
Higher levels trade CPU and latency for size reduction; avoid event-loop stalls
when choosing thresholds and levels.

</LanguageContent>

<LanguageContent language="go">

Compression and decompression use the native Go codec in the operation's work.
Measure CPU cost as well as payload savings, and keep application concurrency
bounded for large values.

</LanguageContent>

<LanguageContent language="rust">

The async engine offloads compression for payloads at least 64 KiB and levels
10–22 once the threshold is met; every zstd decompression is offloaded. The
default CPU executor shares two workers and two queue slots across instances.
Saturation fails open: reads fall through to the source, failed compression skips
the write. Custom codecs still choose their own scheduling.

</LanguageContent>

Use the size, ratio and duration [metrics](observability.md#compression-metrics)
to evaluate the tradeoff.

Decompressed output is capped at 512 MiB. Writes above the same ceiling remain
raw. With compression enabled, `below_threshold` takes precedence;
`write_over_limit` records an oversized payload that also reaches the threshold.
When native zstd rejects marked input, DialCache hands the original bytes to the
serializer (`fallback_raw`, or `read_over_limit` when the output limit caused
rejection). Native decoder acceptance is not corruption
validation: it can accept empty or truncated bodies as empty output and ignore
trailing bytes. A custom serializer must validate the application value it
receives, whether decompressed or raw. A compression exception fails the write
open.

See [Upgrading](upgrading.md#compression-and-value-schemas) for legacy binary
collisions and readers-first deployment of the envelope.

## Bundled Redis operations

### Reads

| Mode | Command | Meaning |
| --- | --- | --- |
| Untracked | `GET valueKey` | Decode one frame; ordinary client read routing applies |
| Tracked | `MGET valueKey watermarkKey` | Decode one authoritative value/watermark snapshot from the primary |

Each semantic read is one top-level command and one round trip. The payload
travels to the application before frame validation, watermark fencing, age checks, and
deserialization. An invalidated large value therefore still consumes transfer
bandwidth until it expires or is replaced.

The semantic adapter returns either a decoded frame containing payload and
creation time, or a classified miss with an optional observed watermark.
DialCache then checks logical age against the effective TTL. Invalid or
future-dated frames miss before deserialization. With recovery enabled, the
initial read can retain expired bytes while the source runs; see
[Stale-on-error](stale-on-error.md).

Native wrong-type behavior is preserved. Untracked `GET` can reject with
`WRONGTYPE`. `MGET` represents a wrong-type member as `nil`: a wrong-type value
is absent, and a wrong-type watermark acts like a missing watermark. Explicit
invalidation repairs a wrong-type watermark.

### Writes

Every dispatched write uses the same complete-frame operation:

```text
SET valueKey frame PX cacheTtlMs
```

The frame carries the writer application's epoch timestamp. There is no value
write script, placeholder, transaction, or watermark mutation. Same-key writes
are last-writer-wins; tracked **reads** enforce invalidation.

Physical TTL is normally the remote TTL. With stale-on-error it is the maximum
recovery age instead. DialCache separately caps tracked values at one hour and emits
`tracked_ttl_clamped` for each dispatched write whose requested TTL exceeds the
cap. Untracked values retain their configured TTL, up to 365 days.

A tracked miss can carry a valid observed watermark. DialCache skips a replacement
already known to be fenced, checking once before payload preparation and again
immediately before dispatch. An admitted write uses the final timestamp exactly.
Misses without that fence let the adapter sample its application epoch clock
before dispatch.
No path adds a fence-check command. See [Conditional refills](invalidation.md#conditional-refills).

### Invalidation retries and ambiguity

Invalidation is the only Lua operation. Bundled adapters dispatch `EVALSHA` and
retry a rejected dispatch once using `EVAL` with the source and the same
invalidation timestamp. The script only advances the watermark and widens its
retention, so duplicate execution after an ambiguous response is harmless.
Invalid reply-domain values are errors and are not retried.

<LanguageContent language="typescript">

If the retry also fails, GLIDE attaches the original error as `cause` when
possible. Node-redis surfaces the retry rejection unmodified because some
client errors are shared objects. A healed retry looks like success to DialCache
metrics; server command statistics expose unexpected `EVAL` activity.

</LanguageContent>

<LanguageContent language="go">

A failed retry surfaces its native error. A healed retry is reported as success;
server command statistics can reveal unexpected `EVAL` activity.

</LanguageContent>

<LanguageContent language="rust">

A failed retry surfaces its native error. A healed retry is reported as success;
server command statistics can reveal unexpected `EVAL` activity.

</LanguageContent>

A rejected or timed-out dispatched mutation does not prove that Redis remained
unchanged. Native writes do not implement compare-and-set or deduplicate retries
performed by an application or client.

### Redis compatibility and ACLs

The integration suite covers Redis 6.2, Valkey 8, and Redis Cluster. The bundled
operations require `GET`, `MGET`, and `SET`, plus `EVALSHA` and `EVAL` for
invalidation. If commands called inside scripts are checked separately, allow
`GET`, `SET`, and `PTTL` for the invalidation script.

DialCache does not issue `TIME`, `MULTI`, `EXEC`, `WATCH`, `UNLINK`, or
`SCRIPT LOAD`. Tracked invalidation also requires the
[clock and watermark durability contract](invalidation.md#application-clock-contract).

## Custom-client contract

A semantic remote adapter must implement three operations: one decoded read,
one complete-frame write, and explicit watermark invalidation. Tracked reads
must use one primary snapshot of value and watermark. Returned payload bytes
must remain stable while the cache retains them for shadow or recovery.

An observed watermark must come from that same valid tracked snapshot. Cause
and fence are independent: an absent value can carry a valid fence. Honor an
explicit write timestamp exactly; otherwise sample application epoch time before
dispatch. Invalidation retries must reuse their original logical timestamp.

<LanguageContent language="typescript">

Implement the three methods of `DialCacheRedisClient` and pass the object in
`redis.client`:

| Method | Return | Required semantics |
| --- | --- | --- |
| `read(request, context?)` | `RedisReadResult` or Promise | Decode the frame; atomically apply the primary watermark for tracked reads |
| `write(request)` | `void` or Promise | Write one complete frame with a finite TTL; honor an explicit `createdAtMs` exactly |
| `invalidate(request)` | `void` or Promise | Advance the watermark monotonically using the client timestamp and preserve required retention |

`read` receives `valueKey` and, only for tracked reads, `watermarkKey`.
`RedisReadContext` supplies `timeoutMs` and an `AbortSignal` for cooperative
cancellation. Returned payload bytes transfer to DialCache and must remain stable
while retained for shadow or recovery; return a dedicated Buffer if the client
pools or reuses response storage.

Use `decodeRedisReadResult` or `decodeTrackedRedisReadResult` from
`dialcache/redis-protocol`, or preserve their behavior exactly. Attach an
`observedWatermarkMs` only from the same valid tracked snapshot. Cause and fence
are independent: an absent value can carry a fence. DialCache validates the fence,
discards it for untracked keys, and maps unknown results/reasons to
`unclassified` misses. A `watermark_fenced` claim also becomes `unclassified` if
its observation is absent, invalid, or discarded for an untracked key.
Normalizing an unknown reason does not discard an otherwise valid tracked
observation. Use `isRedisReadMiss(result)` instead of a null comparison.

`write` receives `valueKey`, `value`, `cacheTtlMs`, and optional `createdAtMs`.
If present, that timestamp is the final value DialCache admitted against an observed
fence: honor it exactly. Otherwise sample real client time before dispatch.
A constant timestamp is incompatible with logical age enforcement.

`invalidate` receives `watermarkKey` and `futureBufferMs`. Supply a valid
`Date.now()` sample to `INVALIDATE_CACHE_SCRIPT` and reuse it across retries of
that logical operation. The public script takes `[futureBufferMs,
invalidatedAtMs]` as its arguments and returns integer `1`.

Bound connection, queue, dispatch, retry, reconnect, and response lifetimes.
DialCache bounds read waits but does not own the client's resource lifecycle or add
write/invalidation deadlines.

</LanguageContent>

<LanguageContent language="go">

Implement `Remote` and supply it with `WithRemote`. Its `Read` receives a context
and optional watermark key, `Write` receives payload, TTL and timestamp, and
`Invalidate` receives the watermark key, invalidation time and buffer. Use native
frame/protocol helpers to preserve classified misses and observed fences. The
[Go API reference](api.md) is generated from the actual interface.

</LanguageContent>

<LanguageContent language="rust">

Implement the asynchronous `Remote` trait and supply it to the cache builder.
`ReadRequest`, `WriteRequest` and `InvalidateRequest` carry the semantic fields;
`ReadResult` distinguishes frames from classified misses. Use the public protocol
module helpers. The [Rust API reference](api.md) documents the exact trait and
ownership types.

</LanguageContent>

Bound connection, queue, dispatch, retries and settlement. The read deadline
bounds DialCache's wait; it does not supply write or invalidation budgets.

## Advanced wire protocol

<LanguageContent language="typescript">

The protocol subpath exports:

| Export | Contract |
| --- | --- |
| `encodeRedisFrame(payload, createdAtMs)` | Copy a `string \| Buffer` into a new version-1 Buffer; timestamp must be a nonnegative safe-integer number or it throws `RangeError` |
| `decodeRedisReadResult(raw)` | Decode one `Buffer \| null` reply into a frame or classified miss |
| `decodeTrackedRedisReadResult(raw, rawWatermark)` | Decode an atomic pair of `Buffer \| null` replies and preserve a valid observed fence on misses |
| `isRedisReadMiss(result)` | Test for a non-null object with `kind === "miss"`; does not validate its reason or watermark |
| `INVALIDATE_CACHE_SCRIPT` | Lua source; one watermark key and arguments `[futureBufferMs, invalidatedAtMs]`; returns numeric `1` |
| `validateRedisSetReply(reply)` | Accept exactly `"OK"` or a Buffer decoding to `"OK"`; return void, otherwise throw `DialCacheRedisProtocolError` |
| `validateRedisScriptInvalidationReply(reply)` | Accept and return numeric `1` only; otherwise throw `DialCacheRedisProtocolError` |
| `ceilSupportedCacheTtlMs(value)` | Accept a number whose ceiling is in `1..31_536_000_000` ms; return that ceiling, otherwise throw `RangeError` |

`CacheMissReason`, `DecodedRedisFrame`, `RedisReadMiss`, and `RedisReadResult`
are also exported as types from this subpath.

</LanguageContent>

<LanguageContent language="go">

The Go package exports frame codecs and protocol helpers beside the semantic
adapter. See the [Go API reference](api.md) for their native signatures. The
wire layout and watermark rules below are shared across ports.

</LanguageContent>

<LanguageContent language="rust">

The Rust `protocol` module exports frame codecs and protocol helpers. See the
[Rust API reference](api.md) for their native signatures. The wire layout and
watermark rules below are shared across ports.

</LanguageContent>

A stored value has a ten-byte header followed by payload:

| Bytes | Meaning |
| --- | --- |
| `0` | Version `1` |
| `1..8` | Big-endian unsigned 64-bit application epoch timestamp; writers must stay within the JavaScript safe-integer domain |
| `9` | Encoding: `0` UTF-8 string, `1` binary |
| `10..` | Payload, possibly a compression envelope |

### Read decoding and validation order

Adapters must validate reply shapes before classifying frames. For a tracked
snapshot, validate both value and watermark replies. Payload ownership must
remain stable through later use; copy borrowed or pooled buffers when needed.

<LanguageContent language="typescript">

Both decoders reject invalid raw reply types, including JavaScript strings, with
`DialCacheRedisPayloadError`. The tracked decoder validates both reply types
before classifying either value. Binary payloads are views into the input frame;
copy them if the backing Buffer may be mutated or reused.

</LanguageContent>

<LanguageContent language="go">

Go exposes native byte slices and errors. A custom adapter must preserve the
shared decoding order; do not turn malformed present metadata into absence.

</LanguageContent>

<LanguageContent language="rust">

Rust exposes owned `Payload` values and native protocol errors. A custom
adapter must preserve the shared decoding order; do not turn malformed present
metadata into absence.

</LanguageContent>

After reply validation, a null value is `value_absent`; a short frame or unknown
version is `unclassified`. Either tracked miss can preserve a valid paired
watermark. Watermark text must contain decimal digits only and represent a value
from zero through `9_007_199_254_740_991`. Zero and leading zeros are accepted;
signs, whitespace, fractions, and exponent notation are not. A missing watermark
uses a zero baseline and does not attach `observedWatermarkMs`.

For a supported tracked frame, malformed present watermark text produces
`unclassified`. A zero frame timestamp also produces `unclassified`. A positive
timestamp at or below a valid watermark produces `watermark_fenced`. These
checks precede payload decoding, so even an unknown encoding can be hidden by
one of these misses. An otherwise eligible frame with an unsupported encoding
returns the native unsupported-encoding error.

The untracked decoder accepts a zero timestamp, but ordinary cache reads still
apply safe-timestamp and logical-age checks before serving. Low-level decoding
alone does not establish freshness or safe reuse.

<LanguageContent language="typescript">

The TypeScript decoders convert raw uint64 timestamps to JavaScript numbers,
which can lose precision beyond the safe-integer domain. DialCache separately
rejects unsafe timestamps before serving.

</LanguageContent>

<LanguageContent language="go">

Native integer representations can retain larger numbers, but interoperable
writers and ordinary readers still enforce the shared JavaScript safe-integer
timestamp domain.

</LanguageContent>

<LanguageContent language="rust">

Native integer representations can retain larger numbers, but interoperable
writers and ordinary readers still enforce the shared JavaScript safe-integer
timestamp domain.

</LanguageContent>

See the [age and clock rules](observability.md#value-ages-and-clock-offsets).

### Invalidation script and payload envelope

The script requires digit-only decimal arguments in the nonnegative safe-integer
domain. The buffer must be at most `31_536_000_000` ms, and timestamp plus buffer
must remain safe. Invalid arguments return Redis errors before any mutation.
Its repair and retention rules are covered under
[Watermark lifetime](invalidation.md#watermark-lifetime).

The binary payload envelope uses `0x00` to escape raw marker-prefixed bytes,
`0x01` for compressed string output, and `0x02` for compressed binary output.
Adapters treat the payload as opaque: DialCache interprets this envelope above them.
The physical value key appends `:dialcache-frame-v1` to the logical key.

Read [Upgrading](upgrading.md) before migrating an older adapter or namespace.
