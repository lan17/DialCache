# DialCache for Go

DialCache organizes caching into use cases, with runtime control and
observability for each one. This module is its Go port.

**TypeScript is the reference implementation. Go is experimental.** Go replays
the same Quint-generated behavior histories as TypeScript and Rust, and one
release version covers all three.

[Shared guides](https://lan17.github.io/DialCache/)
· [Go integration guide](https://lan17.github.io/DialCache/languages/go.html)
· [API reference](https://pkg.go.dev/github.com/lan17/DialCache/go)

- **Off by default:** caching runs only inside an `Enable` scope.
- **Multi-layer:** request-local → process-local → Redis.
- **Runtime policies per use case:** layers, TTLs, and rollout ramps.
- **Targeted invalidation:** one call per entity for its tracked Redis results.
- **Coalescing:** same-key reads share work when a cache layer is active.
- **Fail-open:** cache failures fall back to the source.
- **Stale-on-error (opt-in):** retained Redis values for selected source errors.
- **Shadow validation (opt-in):** cache coherence checks through sampling.
- **Observability:** Prometheus and Datadog metrics, including miss reasons.

## Install

```bash
go get github.com/lan17/DialCache/go@latest
```

Requires Go 1.25 or later. Releases are tagged `go/vX.Y.Z` on the commit that
publishes npm `X.Y.Z`, starting at `go/v0.24.0`; one version means one behavior
contract in every language. Redis is optional. The adapter wraps a
[go-redis](https://github.com/redis/go-redis) v9 client that the application
creates and owns, timeouts and retries included.

## Usage

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	dialcache "github.com/lan17/DialCache/go"
)

func main() {
	cache := dialcache.MustNew() // One instance per process serves every use case.

	// The source: the database or service read.
	fetchDisplayName := func(ctx context.Context, userID string) (string, error) {
		fmt.Println("Loading from source:", userID)
		return "Ada", nil
	}

	// Register once; call displayName at read sites.
	displayName, err := dialcache.Cached(cache, dialcache.Operation[string]{
		Identity: dialcache.Identity{
			KeyType: "user",        // Entity kind; groups tracked results by ID.
			UseCase: "displayName", // Operation name; part of the key and metric labels.
		},
		// Request-local reuse plus a 60-second process-local cache. Redis stays off.
		Policy: dialcache.Policy{RequestLocal: true, LocalTTL: 60 * time.Second},
	}, func(userID string) (dialcache.Identity, error) {
		// The key: include every input that changes the result.
		return dialcache.Identity{ID: userID}, nil
	}, fetchDisplayName)
	if err != nil {
		log.Fatal(err)
	}

	// In a service, open one scope per request and pass its context to every read.
	ctx, done := cache.Enable(context.Background())
	defer done()
	name, err := displayName(ctx, "123") // Loads from source and caches the result.
	if err != nil {
		log.Fatal(err)
	}
	name, err = displayName(ctx, "123") // Reuses the value for up to 60 seconds.
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(name)

	// Outside an enabled scope, every read goes straight to the source.
	if _, err := displayName(context.Background(), "123"); err != nil {
		log.Fatal(err)
	}
}
```

Values reused from memory are shared, not copied: treat them as immutable and
copy before modifying. `GetOrLoad` provides the same cache path for an inline
source and a direct key.

Shared caching adds a Redis layer. A tracked use case can be invalidated per
entity:

```go
// The application owns the client and its timeout, retry and pool settings.
client := redis.NewClient(&redis.Options{Addr: "localhost:6379"})
cache := dialcache.MustNew(dialcache.WithRemote(dialcache.NewRedisAdapter(client)))

profile, err := dialcache.Cached(cache, dialcache.Operation[Profile]{
	// Tracked: Invalidate retires every Redis result for the entity at once.
	Identity: dialcache.Identity{KeyType: "user", UseCase: "profile", Tracked: true},
	Policy:   dialcache.Policy{LocalTTL: time.Second, RemoteTTL: time.Minute},
}, func(userID string) (dialcache.Identity, error) {
	return dialcache.Identity{ID: userID}, nil
}, fetchProfile)

// After committing a change to user 42:
err = cache.Invalidate(ctx, dialcache.Identity{KeyType: "user", ID: "42"}, 0)
```

## Enable caching per request

`ctx, done := cache.Enable(parent)` opens a request scope; reads that receive
`ctx` may use the cache. `done()` closes it: request-local values are
discarded, late results cannot enter, and a context kept after `done()` no
longer caches. Enabling inside a live scope joins it, and the inner close does
nothing.

Any other context passes straight through to the source: no key selection, no
policy lookup, no coalescing, no source deadline. That is how write paths stay
uncached.

| Call | Purpose |
| --- | --- |
| `cache.Enable(ctx)` | Returns the enabled context and its `done` function; usually one per request. |
| `cache.WithEnabled(ctx, fn)` | Runs `fn` inside a scope that closes when `fn` returns. |
| `cache.Disable(ctx)` | Derives a pass-through context for mutation work inside a live scope. |
| `cache.IsEnabled(ctx)` | Reports whether reads with `ctx` participate in caching. |

## Define use cases

`Cached` registers a use case once and returns a typed function. Its argument
may be a struct with several source inputs; the key selector maps it to an
`Identity` and runs only for enabled calls. `GetOrLoad` runs one inline source
without registration. Both snapshot the static policy and source timeout before
any asynchronous work: `Cached` at registration, `GetOrLoad` when called.

One `Cache` serves every value type, so one local capacity, one coalescing
table and one shadow-job capacity cover the process. The use case name
`watermark` is reserved, and a name registers once per instance.

Keys are shared with TypeScript and Rust. `Identity` takes normalized strings
and ordered argument pairs. `NormalizeArgs` applies the shared scalar rules:
UTF-16 name order, number spelling, omission of `Absent`, escaping, and Cluster
hash tags for tracked keys. Processes sharing Redis entries must agree on
namespace, key dimensions, codec and policy.

## Set and change policy

`Policy` uses `time.Duration`: TTLs and the stale-on-error age are whole
seconds, deadlines whole milliseconds. A zero TTL leaves that layer off.
Pointer fields such as `Coalesce: Ptr(false)` or `LocalRamp: Ptr(0.0)` separate
an explicit value from an omitted one. `ParsePolicy` reads the JSON shape
shared with TypeScript.

`WithPolicyProvider` runs once per enabled call and returns a sparse overlay: a
typed `*PolicyOverlay`, a `JSONPolicy` map in the shared shape, or `RawPolicy`
around a decoded reply. A nil overlay inherits everything; a present field
replaces the static value. Changes apply to new calls only and never evict
values or cancel admitted work.

Invalid runtime values have narrow effects. A provider error, a malformed
overlay or an invalid read deadline bypasses caching for that call. An invalid
TTL or ramp turns off only that layer; an invalid recovery or shadow setting
turns off only that feature. Explicit JSON `null` is invalid, not omitted. See
[Configuration and rollout](https://lan17.github.io/DialCache/configuration.html).

## Connect Redis

`WithRemote(NewRedisAdapter(client))` adds the shared layer for any go-redis
standalone, Sentinel or Cluster client. Tracked reads on a
`*redis.ClusterClient` always go to the slot primary, even with replica reads
enabled. Standalone and Sentinel clients must already target the primary; keep
Sentinel's `FailoverOptions.ReplicaOnly` false, or replica lag can hide an
invalidation.

Invalidation uses a watermark: a per-entity cutoff timestamp in Redis that
makes older tracked values unusable. `Invalidate(ctx, identity, futureBuffer)`
raises it for every tracked use case and argument variant of the entity named
by `KeyType` and `ID`. The future buffer widens the cutoff to catch stale
writes that land after the invalidation
([choosing it](https://lan17.github.io/DialCache/invalidation.html#choosing-futurebufferms)).
`Invalidate` needs a remote (`ErrNoRemote` otherwise) and changes Redis only:
process-local entries expire by their own TTL, and a value already read stays
valid for that call. Value writes never create or extend a watermark.

On the wire, a value write is one `SET`. Invalidation runs the shared Lua
script with `EVALSHA` and retries a rejected dispatch once with `EVAL`; a
successful but malformed reply is an error, not a retry. A custom `Remote` must
read value and watermark from one primary snapshot, write each entry completely
in one `SET`, and surface invalidation errors. See
[Redis and Valkey](https://lan17.github.io/DialCache/redis.html),
[Targeted invalidation](https://lan17.github.io/DialCache/invalidation.html)
and the
[custom-client contract](https://lan17.github.io/DialCache/redis.html#custom-client-contract).

Compression is on by default: a serialized value at or above 4,096 bytes is
stored with zstd level 3 when that shrinks it. `WithCompression` tunes both
numbers. `WithoutCompression` stops compressing new writes; reads still accept
compressed entries, and raw values resembling a compression marker are still
escaped. Ports interoperate on decompression, not on identical bytes.

## Handle errors and deadlines

Cache plumbing fails open: a failing key selector, policy, cache read, codec or
write falls back to the source, and the call returns the source result. Source
errors come back unchanged, so `errors.Is` and `errors.As` work. Maintenance
calls such as `Invalidate` return their errors.

| Error | Meaning |
| --- | --- |
| `ErrInvalidOption` | `New` rejected an option; `MustNew` panics instead. |
| `ErrInvalidPolicy`, `ErrInvalidOperation` | Validation rejected a static policy or operation before any work ran. |
| `ErrReservedUseCase`, `ErrUseCaseRegistered` | The name `watermark` is reserved; a use case registers once. |
| `ErrNoRemote` | `Invalidate` needs a Redis adapter. |
| `FallbackTimeoutError` | The source missed its deadline (default 60 s). The caller gets this error, the source keeps running, and stale-on-error may serve a retained value. |
| `RemoteReadTimeoutError` | A Redis read missed its deadline (default 50 ms). Internal: the call falls through to the source, and observers see the reason. |
| `CallbackPanicError` | A source, codec, policy provider or comparator panicked. Observer, metrics and logger panics are ignored. |

A source deadline does not cancel the source; cancelling its context stays with
the application. A read deadline requests cancellation through the adapter
context but cannot prove a dispatched command stopped.

Stale-on-error is off until a use case sets `StaleOnErrorMaxAge`.
`WithStaleRecovery` (instance default) or `Operation.ShouldRecover` chooses
which source errors may serve a retained Redis value; without either, only
`FallbackTimeoutError` qualifies. See
[Stale-on-error](https://lan17.github.io/DialCache/stale-on-error.html).

## Choose value types and codecs

`JSONCodec[T]` is the default. With `T = any` it keeps the full JSON domain
plus `Absent`, the Go spelling of TypeScript `undefined`; nil is JSON null.
False, zero, empty strings, null and absence are cached values, never misses.
Typed destinations follow Go field, tag and numeric-range rules, so use `any`
for anything TypeScript may have written. JavaScript-only details such as
prototypes and shared references do not cross languages.

Strings hold Unicode scalar values. Valid escaped surrogate pairs decode
normally; an unpaired UTF-16 surrogate escape is rejected, and the read fails
open rather than changing the value. Carrying such values needs a custom codec.

Go maps have no insertion order, so `JSONCodec` writes keys in deterministic
UTF-16 order; use `JSONObject` when stored byte order must match. The codec
follows JavaScript for non-finite numbers and absence, rejects cycles and big
integers, and encodes byte slices like Node's `Buffer` JSON form.
`Operation.Codec` takes a custom `Codec[T]`; a `ContextCodec[T]` also receives
the call's context. Decoders must return independent values, and values reused
from memory are immutable to callers.

## Export metrics and logs

`WithObserver` receives every diagnostic `Event`; `WithMetrics` connects a
`MetricsAdapter` such as `NewPrometheusMetrics` or `NewDatadogMetrics`. Every
observer and adapter gets each event, and a failing or panicking one never
changes a cache, source or maintenance result. Metric names, labels, units and
buckets match the TypeScript exporters; logical keys never become labels.
`WithLogger` replaces the standard logger with the same isolation, and
`GetCoalescingState` reports live process leaders, followers and the oldest
leader age.

Shadow validation runs only when `WithShadowOutcomes` is set: the hook receives
each verdict and admits shadow jobs. It sees the same event the observers do,
so export a verdict through one path to avoid double counting.
`WithRecoveryOutcomes` is the matching stale-recovery hook. A shadow job that
times out holds its capacity slot until its own work finishes, and abandoned
work never fills or confirms later. Mismatch logging is opt-in per use case
(`ShadowPolicy.LogMismatches`): one bounded warning per confirmed mismatch. The
default comparator is `SemanticEqual`; `Operation.Comparator` replaces it.

Prometheus adapters reuse collectors created earlier for the same registry and
prefix. To bind collectors registered elsewhere, pass their instances and
construction schemas to `NewPrometheusMetricsWithBindings`; the schema is
required because Go's registry cannot expose empty histogram buckets. See
[Observability](https://lan17.github.io/DialCache/observability.html) and the
[binding contract](../formal/GO-PARITY.md#current-configuration-and-observability-bindings).

## Defaults

| Setting | Default | Change with |
| --- | --- | --- |
| Namespace | `urn` | `WithNamespace`; an empty namespace is allowed |
| Process-local capacity | 10,000 entries across all use cases | `WithLocalCapacity`; `0` disables storage but keeps coalescing |
| Redis read deadline | 50 ms | `WithRemoteReadTimeout`; `Policy.RemoteReadTimeout` per use case |
| Source deadline | 60 s | `Operation.SourceTimeout`; `NoTimeout` removes it |
| Compression | on; 4,096-byte threshold, zstd level 3 | `WithCompression`, `WithoutCompression` |
| Shadow jobs in flight | 1 per instance; extra jobs are dropped, not queued | `WithShadowCapacity` |
| Recoverable source errors | `FallbackTimeoutError` only | `WithStaleRecovery`, `Operation.ShouldRecover` |
| Cache layers | all off | `Policy` per use case |

## Advanced clock and executor hooks

Normal use needs none of these. `WithClock` separates wall time (timestamps)
from elapsed time (TTLs and deadlines), mainly for tests. A custom clock may
add `PreciseClock` for fractional-millisecond deadlines, `TimerClock` for the
matching timer source, and `DeferredExecutor` to control detached work. Local
expiry uses whole milliseconds, matching TypeScript; deadlines compare precise
elapsed time, and a timer callback rechecks the clock before declaring a
timeout. Details:
[native clock precision](../formal/GO-PARITY.md#native-clock-precision).

## Verify the port

The [Quint models](../formal/README.md) are the behavioral source of truth.
TypeScript, Go and Rust replay the same generated histories, named regressions,
fixed scenarios and protocol vectors. One language-neutral evaluator,
`node formal/witnesses.mjs evaluate`, decides whether those histories reach
every required boundary, so no port depends on another port's test suite. These
are finite checks of the documented contract, not proof of every input or
schedule. The Go port was written from the models and contracts with TypeScript
source review; it is not a clean-room implementation.

Run Make targets from the repository root. A Node replay coordinator supplies
commands and checks observations; expected states never enter the Go driver,
all cache behavior runs in Go, and the module itself has no Node dependency. CI
pins Go 1.27.1, Node 24 with pnpm 10.33.0, Quint 0.32.0 with Rust evaluator
0.6.0, and Java 21.

| Target | What it runs | Extra tools |
| --- | --- | --- |
| `make check-go` | vet, gofmt, unit tests with race detection, committed smoke histories | none |
| `make integration-go` | Real Redis, Valkey and Cluster servers, plus TypeScript interoperability | Docker |
| `make formal-go` | Complete replay of the generated corpus, after `make formal-generate` | Node 24; Quint for generation |
| `make mutations-go` | Go fault catalog over the corpus and shared witness evidence | Docker |
| `make model-check` | Separate finite symbolic checks | Java 21, `tar` |

Every pull request runs `check-go`, `integration-go` and the evidence audit.
The full formal, symbolic and mutation workflow runs weekly and on demand. A
smoke pass does not establish parity; behavior or model changes need the full
run before merge. `make check` runs every language's fast checks and `make ci`
every local lane; see the
[maintainer guide](https://lan17.github.io/DialCache/maintainers.html#validation)
and the shared
[setup steps](../formal/README.md#generating-and-replaying-behavior).

Reproduce one history by pointing the matching selector at a file instead of a
directory:

```sh
DIALCACHE_FEATURE_TRACE_FILE="$PWD/.formal-traces/regressions/shadow/confirmationPastFreshnessKeepsOriginalPayloadAndAgeTest.itf.json" \
  go -C go test -race -count=1 -run '^TestFeatureConformance$' ./...
```

Core and effects histories use `DIALCACHE_MBT_TRACE_FILE` and
`DIALCACHE_EFFECTS_TRACE_FILE`. Reports and traces live in `.formal-traces/`.
A full replay requires the exact corpus, witness and definition hashes it was
generated with, so a source, corpus or witness change invalidates a completion
report.

Race detection and sampled histories are evidence for the executions they
exercised, not exhaustive concurrency verification or a Redis durability
guarantee. Ledger and coverage: [parity acceptance](../formal/GO-PARITY.md),
[feature and corner-case map](../formal/FEATURE-COVERAGE.md),
[execution inventory](../formal/execution.json), and
[PORTING.md](../formal/PORTING.md) for regeneration and the completion report.
