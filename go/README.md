# DialCache for Go

Read the [shared behavior guides](https://lan17.github.io/DialCache/) and
[Go integration guide](https://lan17.github.io/DialCache/languages/go).
The site uses one explanation per feature with selected native examples and notes.

Go implements the same portable behavior as TypeScript: explicit request
enablement, request/local/Redis layers, deterministic rollout, sparse runtime
policy, request and process coalescing, tracked invalidation, source/read
deadlines, stale recovery, dark and served-hit shadow validation, compression,
and failure-isolated observability.

## Use

The module requires Go 1.25 or later. Applications own
their Redis client and its connection, retry and resource budgets.
The library has no Node.js dependency.

Releases tag the commit that publishes npm version `X.Y.Z` as `go/vX.Y.Z`, so
one version number names one behavior contract in both languages; npm versions
before the first Go tag have none. Install one with `go get github.com/lan17/DialCache/go@vX.Y.Z`.

```go
import (
    "context"
    "time"

    dialcache "github.com/lan17/DialCache/go"
    "github.com/redis/go-redis/v9"
)

client := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
cache, err := dialcache.New(dialcache.WithRemote(dialcache.NewRedisAdapter(client)))
if err != nil {
    return err
}
displayName, err := dialcache.Cached(cache, dialcache.Operation[string]{
    Identity: dialcache.Identity{KeyType: "user", UseCase: "displayName", Tracked: true},
    Policy:   dialcache.Policy{RequestLocal: true, LocalTTL: time.Second, RemoteTTL: time.Minute},
}, func(userID string) (dialcache.Identity, error) {
    return dialcache.Identity{ID: userID}, nil
}, func(ctx context.Context, userID string) (string, error) {
    return "Ada", nil // Replace with the authoritative source.
})
if err != nil {
    return err
}

ctx, done := cache.Enable(context.Background()) // Usually once per request.
defer done()
value, err := displayName(ctx, "42")
```

One `Cache` serves every value type: `Cached[T, Arg]` and `GetOrLoad[T]` are
generic functions over the same instance. Its local capacity and shadow budget
are shared across those types. Caching is off until `Enable`
returns a request-scoped context; calls with any other context pass straight
through to their source without key selection, policy resolution, coalescing
or a source deadline. `done` closes the scope, ending its request memo and
preventing late publication into it; retaining the context afterwards does not
keep caching enabled. `WithEnabled` runs a callback inside such a scope,
`Disable` returns a pass-through context inside a live scope, and `IsEnabled`
reports the state.

`Cached` registers a use case once and returns a typed function. Its argument
can be a struct containing several source inputs; the key selector runs only
for an enabled call and supplies the `ID` and `Args`. `GetOrLoad` runs one
inline loader without registering a use case. Both capture the static policy
and source timeout before any asynchronous work. Use case `watermark` is
reserved (`ErrReservedUseCase`) and a second registration fails with
`ErrUseCaseRegistered`; both work with `errors.Is`. `GetCoalescingState`
reports actual process leaders, followers and the oldest leader age.

`Identity` takes normalized strings and ordered argument pairs. Use
`NormalizeArgs` for JSON-shaped scalar arguments; it preserves TypeScript's
UTF-16 name ordering, numeric formatting, omission of `Absent`, escaping, and
tracked Redis hash tags. Use the same namespace, key dimensions, codecs and
policy in both languages when sharing entries.

## Configuration and effects

`Policy` uses `time.Duration`. Cache TTLs and recovery ages are whole seconds;
source and read deadlines are whole milliseconds. A zero TTL omits a layer, and
pointer leaves such as `Ptr(false)` or `Ptr(2 * time.Hour)` distinguish an
explicit false or zero from an omitted setting that inherits. `ParsePolicy`
accepts the TypeScript JSON-shaped static configuration with its seconds-based
fields. `WithPolicyProvider` resolves a sparse overlay once per enabled
invocation: return a typed `*PolicyOverlay`, a `JSONPolicy` map in the shared
JSON shape, or `RawPolicy` around an arbitrary decoded reply. A nil overlay
inherits; explicit null leaves keep their invalid-value meaning. Malformed
invocation policy bypasses caching. An invalid layer TTL or ramp leaf disables
only that layer; an invalid recovery age disables stale recovery, and an invalid
shadow ramp disables shadow validation.

`New` takes options and returns an error wrapping `ErrInvalidOption` for an
invalid one; `MustNew` panics instead. Defaults are namespace `urn`
(`WithNamespace` permits an empty one), local capacity 10,000
(`WithLocalCapacity(0)` disables storage while retaining coalescing), 50 ms
remote reads, 60 s source calls (`Operation.SourceTimeout`; `NoTimeout`
disables the deadline), compression on, and shadow capacity one. Invalid
operation configuration returns an error wrapping `ErrInvalidPolicy` or
`ErrInvalidOperation` before execution.

`WithRemote` requires atomic primary snapshots, complete client-stamped frame
writes, and surfaced invalidation errors. The bundled `RedisAdapter` uses
go-redis with standalone, Sentinel or Cluster clients; `NewRedisClient` builds
one from standard `redis.UniversalOptions` and fills zero budget fields. For a
direct `*redis.ClusterClient`, tracked reads select the slot primary even when
replica reads are enabled. Standalone and Sentinel `*redis.Client` handles must
already target the primary; keep Sentinel's
`FailoverOptions.ReplicaOnly` false so replica lag cannot hide an invalidation
watermark. `NewRedisClient` rejects Sentinel `ReadOnly`; the adapter cannot see
that option on a client built elsewhere. Writes and invalidation wait
for the native client, so size its pool and timeouts for the cache
([Redis client budgets](https://lan17.github.io/DialCache/languages/go#redis-client-budgets)).
Writes use one native `SET`.
Invalidation first dispatches `EVALSHA`; any command rejection
triggers one retry with `EVAL` using identical logical arguments. A successful
command with an invalid reply does not trigger a retry. No value write creates
or extends a watermark. `Invalidate` needs a remote (`ErrNoRemote` otherwise)
and affects shared remote authority; other processes' local entries and
already acquired snapshots retain the documented lifetime rules.

Source errors retain their identity. A source deadline returns
`FallbackTimeoutError` and does not cancel raw source work. A read deadline
returns `RemoteReadTimeoutError` to cache plumbing and requests cancellation
through the adapter context; it cannot prove a dispatched command stopped.
Source/codec/provider/comparator panics become `CallbackPanicError`; telemetry
panics are ignored. Cache plumbing fails open while explicit maintenance errors
are returned. Applications still own cancellation of the source context.

`WithClock` separates wall time from elapsed time. The default clock preserves
fractional milliseconds through `PreciseClock.ElapsedTime`. Custom clocks can
implement that optional interface; existing `ElapsedMS`-only clocks retain their
supplied integer resolution. Source/read/shadow deadlines compare precise
elapsed durations, and millisecond timers round remaining delays upward. Local expiry
matches TypeScript's whole-millisecond monotonic clock observations at insertion
and lookup; it does not use the fractional deadline-clock resolution. A custom clock should
implement `TimerClock` for corresponding deadline delivery; `DeferredExecutor` provides
an optional executor for detached work. Normal use needs none of these hooks.
Owned unfinished shadow work retains its capacity after a reported timeout,
and abandoned work cannot initiate a later fill or confirmation.

## Values, codecs and observability

`JSONCodec[T]` is the default codec. For `any` it preserves the supported JSON
domain plus explicit `Absent` (TypeScript `undefined`). Nil represents JSON
null. False, zero, empty text, null and absence are cached values, never
misses. Typed destinations apply Go field/tag and numeric-range rules; use
`any` when the full domain is required. Native object prototypes and reference
identity are language bindings. JSON strings and object keys use Unicode scalar
values. Valid escaped surrogate pairs decode normally; an unpaired UTF-16
surrogate escape is rejected so a cached TypeScript value outside this domain
fails open instead of being silently changed. A custom codec is needed to
preserve such non-scalar code units.

Use `JSONObject` to preserve insertion order when JSON byte identity matters.
Go maps have no insertion order and use deterministic UTF-16 order. Argument
maps always follow their prescribed sorted order. The JSON codec follows
JavaScript nonfinite/absence behavior, rejects cycles and big integers, and
encodes byte slices using the Buffer JSON convention. A custom `Codec[T]`, with
optional `ContextCodec[T]`, replaces the default through `Operation.Codec`.
Decoders must return independent values, and callers must treat reused
in-memory values as immutable.

Compression defaults to a 4,096-byte threshold and zstd level 3;
`WithCompression` tunes both. `WithoutCompression` disables compressed writes;
reads still accept compressed entries, and raw payloads that begin with an
envelope marker are escaped ([compression](https://lan17.github.io/DialCache/redis.html#compression)).
The wire contract requires interoperable decompression, not identical
compressed bytes.

`WithObserver` receives backend-neutral events, and `WithMetrics` connects a
`MetricsAdapter` with failure isolation; every configured observer and adapter
receives each event. To enable shadow admission, also supply
`WithShadowOutcomes`; it represents the optional shadow metric hook and
receives the same verdict event the observers do, so wire an exporter through
one of those paths to avoid double-counting it.
`WithRecoveryOutcomes` is an optional separate recovery hook. Prometheus and
DogStatsD adapters preserve metric names, labels, units and buckets; logical
keys never become labels. `WithLogger` replaces the standard logger, which
writes each entry on one line with control characters escaped; either is
failure-isolated. Mismatch logging is opt-in, confirmed, and bounded.

Prometheus adapters reuse collectors created by an earlier adapter with the
same registry and prefix. To reuse externally registered collectors, supply
their actual instances and construction schemas through
`NewPrometheusMetricsWithBindings`. The schema is a caller precondition because
Go's native registry cannot expose empty histogram buckets; see the precise
[binding contract](../formal/guides/GO-PARITY.md#current-configuration-and-observability-bindings).

## Development

Run the checks from the repository root: `make check-go` runs the native tests with race detection,
`make formal-go` replays the generated corpus, and `make integration-go`
runs the real-server checks. [Validation and evidence](../formal/guides/VALIDATION.md) lists the
prerequisites and the other lanes.
