# Go integration

[Shared guides](../index.md) · [Getting started](../getting-started.md) · [API reference](../api.md)

The Go port uses the shared behavioral contract with native contexts, generic
operations and duration types. This page covers those binding differences.

## Installation and runtime

```bash
go get github.com/lan17/DialCache/go@latest
```

Go 1.25 or later is required. Pin the selected version in `go.mod`. Released Go
modules use `go/vX.Y.Z` tags at the same source commit as npm version `X.Y.Z`;
older npm releases from before the Go port have no matching Go tag. The site
follows `main`, so consult tagged source for an installed older release.

The [getting-started example](../getting-started.md#wrap-a-reader) is imported
from a native Go test. The module also includes a runnable
[`ExampleCached`](https://github.com/lan17/DialCache/blob/main/go/example_test.go).

## Request scope and operations

Create one `Cache` with `dialcache.New`, then register typed readers with
`dialcache.Cached[T, Arg]`. Its source receives a `context.Context` and the
argument; use a struct argument for several inputs. `GetOrLoad[T]` accepts an
inline operation without registration.

`ctx, done := cache.Enable(parent)` opens a request scope. Pass `ctx` to all
readers for that request and call `done` at the boundary, usually with `defer`.
`WithEnabled` provides a callback form. `Disable(ctx)` derives an uncached context.
Closing the scope prevents future caching through retained contexts and late
publication to its memo. Application cancellation of the source context remains
application-owned.

## Policy and errors

`Operation[T].Policy` contains static settings. `WithPolicyProvider` resolves a
sparse `PolicyOverlay`, shared-shape `JSONPolicy`, or `RawPolicy` on each enabled
invocation. Nil leaves inherit; pointers such as `Ptr(false)` distinguish an
explicit disabling value from omission.

`ShadowPolicy.MismatchLogging` selects confirmed-mismatch warning content with
`Value` and a `MismatchDiffLevel` (`MismatchDiffOff`, `MismatchDiffPaths` or
`MismatchDiffValues`); `LogMismatches` is shorthand for both leaves. See
[confirmed mismatch logging](../shadow-validation.md#confirmed-mismatch-logging).

Durations use `time.Duration`: cache TTLs and recovery ages must be whole seconds,
read/source deadlines whole milliseconds. `Operation.SourceTimeout` defaults to
60 seconds when zero; `NoTimeout` explicitly removes that guard. Runtime policy
cannot change that static source budget.

`New` and operation registration return validation errors; `MustNew` panics.
Cache plumbing fails open and source errors preserve identity. Use `errors.Is`
and `errors.As` for native error handling. `FallbackTimeoutError` reports a
source deadline; callback panics become `CallbackPanicError`. `Invalidate`
returns maintenance errors, including `ErrNoRemote` without an adapter.

## Identity and values

`Identity` holds normalized strings and ordered argument pairs. Use
`NormalizeArgs` for scalar arguments; it preserves the shared UTF-16 ordering,
number spelling and omission rules. Include every value-changing dimension in
the identity. Keep one compatible value meaning and codec for each key.

Go assignment does not deep-copy maps, slices or pointers. Treat reused values
as immutable. `JSONCodec[T]` is the default; `Codec[T]` replaces it per operation
and `ContextCodec[T]` optionally accepts a context. Native struct fields and
numeric ranges constrain typed decoding; use `any` for the broader JSON domain.
`Absent` represents TypeScript undefined, while nil is JSON null. Unpaired
UTF-16 surrogate escapes are rejected rather than silently changed.

Use `JSONObject` when JSON insertion order matters. Ordinary maps have no
insertion order. These binding details do not change sorted cache-key arguments.

## Integrations

`NewRedisAdapter` wraps an application-owned go-redis standalone, Sentinel or
Cluster client; supply it with `WithRemote`. `NewRedisClient` builds that client
from standard `redis.UniversalOptions` with
[Redis client budgets](#redis-client-budgets). Tracked reads override replica routing
for direct `*redis.ClusterClient` clients, which need `MULTI` and `EXEC` in Redis
ACLs.
Standalone/Sentinel clients must target the primary; keep Sentinel's
`FailoverOptions.ReplicaOnly` false. `NewRedisClient` rejects Sentinel `ReadOnly`,
which go-redis turns into `ReplicaOnly`.
See [Redis and Valkey](../redis.md) and [invalidation](../invalidation.md).

`WithObserver` receives typed diagnostic events and `WithMetrics` connects
`NewPrometheusMetrics` or `NewDatadogMetrics`. Shadow admission additionally
requires `WithShadowOutcomes`; if an exporter already receives every event,
use this hook only to enable admission rather than forwarding the same outcome
twice. See [observability](../observability.md).

The default shadow comparator is `SemanticEqual`. An operation's `Comparator`
can implement application equality and return an error. Its `MismatchDiff`
replaces the built-in difference computation of confirmed-mismatch warnings; a
`MismatchEntry` side set to `Absent` is omitted. See
[comparison semantics](../shadow-validation.md#comparison-semantics).


### Redis client budgets

DialCache bounds only its own wait for a remote read. The read context has no
deadline: DialCache cancels it when the read budget expires, and `ReadBudget(ctx)`
reports that budget. A command already on the socket runs until the client's
`ReadTimeout`. `Write` and `Invalidate` receive the caller's context without a
DialCache deadline, so only the client's budgets and a caller deadline bound them;
go-redis applies a context deadline to the socket only when
`ContextTimeoutEnabled` is set. The go-redis defaults do not fit the default 50 ms read budget. The pool holds 10
connections per `GOMAXPROCS`, reads and writes may wait 5 seconds, a failed
command is retried 3 times, and a connect is attempted 5 times. On a container
limited to one or two CPUs, a Redis slowdown of a few tens of milliseconds at a
few hundred reads per second fills that pool, so most reads miss the budget and
call the source. One stalled miss-path write or invalidation can block its
caller for many seconds. Size the pool as reads per second times the read
budget, plus room for writes, and keep every wait short. Use a client that
serves only DialCache, so a cache stall does not take connections from other
Redis work.

`NewRedisClient` takes standard go-redis options, and `redis.NewUniversalClient`
picks the client: Sentinel when `MasterName` is set, Cluster for more than one
address or `IsClusterMode`, otherwise standalone. Redis and Valkey work the same
way. The caller owns the returned client and closes it after draining cache work
(excerpt):

```go
client, err := dialcache.NewRedisClient(&redis.UniversalOptions{
	Addrs: []string{"redis:6379"},
})
if err != nil {
	return err
}
defer client.Close()
cache, err := dialcache.New(dialcache.WithRemote(dialcache.NewRedisAdapter(client)))
```

A zero field gets the value below. It is a starting point for up to about 1,000
reads per second at normal Redis latency; measure pool waits and source
fallbacks under load before you rely on it. A field you set keeps your value.
`ContextTimeoutEnabled` is always set.

| Option | Value | go-redis default |
| --- | --- | --- |
| `PoolSize` | 64 | 10 per `GOMAXPROCS` |
| `MinIdleConns` | 8 | 0 |
| `PoolTimeout` | 100 ms | `ReadTimeout` + 1 s |
| `DialTimeout` | 500 ms | 5 s |
| `DialerRetries` | 1 | 5 |
| `ReadTimeout`, `WriteTimeout` | 250 ms | 5 s |
| `MaxRetries` | -1 (no retries) | 3 |
| `ConnMaxIdleTime` | 3 min | 30 min |
| `Protocol` | 2 (RESP3 also works) | 3 |

A read that DialCache stopped waiting for keeps its connection until Redis
replies or `ReadTimeout` ends. In a slowdown longer than the read budget, the
pool fills: other commands wait `PoolTimeout`, then reads call the source and
cache writes fail.

`PoolSize` and `MinIdleConns` apply to each Redis node. `MinIdleConns` opens its
connections in the background when the client starts; set it to -1 for none.
Build one client per process and reuse it.

Give `Invalidate` a context deadline. Do not derive a socket deadline from
`ReadBudget`: a deadline that cuts a slow command closes its connection, and the
reconnects add load while Redis is slow.

## Conformance

The module replays the same histories as TypeScript and Rust. The cache library
has no Node dependency; only repository conformance tooling uses Node. For
native checks run `make check-go` from the repository root. The
[formal guide](https://github.com/lan17/DialCache/blob/main/formal/README.md)
explains complete validation and reproducing one history.
