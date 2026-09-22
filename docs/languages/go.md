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
Cluster client; supply it with `WithRemote`. Tracked reads override replica routing
for direct `*redis.ClusterClient` clients. Standalone/Sentinel clients must target
the primary; keep Sentinel's `FailoverOptions.ReplicaOnly` false.
See [Redis and Valkey](../redis.md) and [invalidation](../invalidation.md).

`WithObserver` receives typed diagnostic events and `WithMetrics` connects
`NewPrometheusMetrics` or `NewDatadogMetrics`. Shadow admission additionally
requires `WithShadowOutcomes`; if an exporter already receives every event,
use this hook only to enable admission rather than forwarding the same outcome
twice. See [observability](../observability.md).

The default shadow comparator is `SemanticEqual`. An operation's `Comparator`
can implement application equality and return an error. See
[comparison semantics](../shadow-validation.md#comparison-semantics).

## Conformance

The module replays the same histories as TypeScript and Rust. The cache library
has no Node dependency; only repository conformance tooling uses Node. For
native checks run `make check-go` from the repository root. The
[formal guide](https://github.com/lan17/DialCache/blob/main/formal/README.md)
explains complete validation and reproducing one history.
