# Configuration and rollout

<a id="configuration"></a>

[Documentation](index.md) · [API reference](api.md)

An enabled request scope permits caching. The effective policy selects which layers
participate and how long they can reuse values. Configure resources once,
define a baseline per operation, and use a provider for runtime changes.

## What belongs where

| Level | Responsibility | Examples |
| --- | --- | --- |
| Instance | Shared resources and instance defaults | Namespace, Redis client and compression, local capacity, metrics, shadow capacity |
| Operation definition | Result identity and execution contract | Key, serializer, invalidation tracking, source deadline, Policy defaults |
| Runtime provider | Policy for one enabled invocation | Layer TTLs and ramps, request-local, coalescing, remote-read deadline, recovery age, shadow policy |

Keep operation definitions stable. Their policy defaults are snapshotted when
registered or invoked; mutating the original config does not change that
baseline. Use the provider to change policy. See [keys and identity](keys.md)
for key design and [the read model](concepts.md) for scopes and layer lifetimes.

<a id="runtime-config-and-ramp-controls"></a>

## Baseline and overlay precedence

The operation's static policy is its baseline. A provider result overrides only
the fields it supplies, including individual entries in nested maps:

```text
runtime field → operation field → library default
```

For example, a rollout can change the local ramp without repeating the TTL:

| Field | Operation default | Runtime override | Effective policy |
| --- | --- | --- | --- |
| `ttlSec.local` | `60` | omitted | `60` seconds |
| `ramp.local` | `100` | `10` | 10% key cohort |

The following executed example starts with request-local and process-local
caching, overrides only coalescing, then explicitly disables both layers. The
assertions check source calls, so a sparse overlay that accidentally discards
inherited defaults fails the example.

<LanguageContent language="typescript">

<<< @/../examples/typescript/docs.mts#runtime-policy{typescript}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/examples/typescript/docs.mts)

</LanguageContent>

<LanguageContent language="go">

<<< @/../go/docs_examples_test.go#runtime-policy{go}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/go/docs_examples_test.go)

</LanguageContent>

<LanguageContent language="rust">

<<< @/../rust/tests/docs_examples.rs#runtime-policy{rust}

[Complete executable example](https://github.com/lan17/DialCache/blob/main/rust/tests/docs_examples.rs)

</LanguageContent>

<LanguageContent language="typescript">

`defaultConfig` accepts `DialCacheKeyConfig`; `cacheConfigProvider` returns a
sparse config or `null`. Defensive `undefined` also inherits. An empty config
inherits all fields. Nested local/remote maps and `shadow` leaves merge separately.

</LanguageContent>

<LanguageContent language="go">

`Operation.Policy` uses `time.Duration` for TTLs and deadlines.
`WithPolicyProvider` can return `*PolicyOverlay`, `JSONPolicy` or `RawPolicy`.
Nil overlay leaves inherit; use pointers such as `Ptr(false)` and `Ptr(0.0)` to
supply explicit false and zero. TTLs use whole seconds, deadlines whole
milliseconds. See the [Go guide](languages/go.md#policy-and-errors).

</LanguageContent>

<LanguageContent language="rust">

Operations use `Policy`; `policy_provider` returns `Option<RuntimePolicy>`.
`Ok(None)` inherits. Converting a `Policy` into a runtime overlay preserves its
omitted leaves. TTL builders use whole seconds and deadline builders use
milliseconds. See the [Rust guide](languages/rust.md#policy-and-errors).

</LanguageContent>

The policy names in the tables below use the shared JSON configuration shape,
also accepted by the Go and Rust policy parsers. Native names and units differ;
use the selected language's API reference when constructing typed policy.
A configured TTL implies a 100% serving ramp unless overridden. Without a TTL,
a local or remote layer is off. Request-local caching and shadow work are off
by default. Coalescing defaults to true, but starts no flight when all serving
layers are inactive.

## Turning features off

Use explicit values to disable inherited policy:

| Overlay | Effect on new invocations |
| --- | --- |
| `requestLocal: false` | Bypass request-local lookup and storage |
| `ramp.local: 0` | Bypass process-local serving |
| `ramp.remote: 0` | Bypass remote serving; shadow admission remains independent |
| `shadow: { ramp: 0 }` | Stop new shadow work; inherit the logging preference |
| `staleOnErrorMaxAgeSec: 0` | Disable stale recovery |
| `coalesce: false` | Use independent cache paths and source deadlines; settled cache hits still apply |
| Disabled-policy overlay | Disable request-local, recovery, and mismatch logging; set both serving ramps and the shadow ramp to `0` |

The disabled-policy overlay leaves TTLs and `coalesce` unset. Inherited TTLs remain
inactive under the zero ramps. Replacing that overlay with a later ramp-up
coalesces unless another field opts out. Disabling does not cancel admitted
work, evict values, or disable explicit invalidation.

## Stable key cohorts

Ramp values are thresholds from 0 to 100. `0` disables the layer, `100` enables
it for every key, and an intermediate value selects keys whose DialCache-owned
deterministic bucket for the full cache key and layer is below that threshold.

For a fixed cache identity and layer, increasing a ramp only adds keys and
decreasing it only removes keys; it does not reshuffle existing membership.
Local and remote cohorts are layer-specific.

Ramps select key cohorts, not requests or load, so a ramp of `10` does not
guarantee 10% of calls, especially for a small or skewed key population.
DialCache keeps the assignment stable across releases.

Applications that need an externally coordinated cohort can use
the runtime provider to return a sparse per-key ramp override of `0` or `100`.

`shadow.ramp` selects its own stable exact-key cohort, independent of both
serving ramps. Shadowing additionally needs a valid remote TTL and a metrics
adapter with the outcome hook. `shadow.logMismatches` controls diagnostic
warnings separately and defaults to `false`.
[Shadow validation](shadow-validation.md) explains eligibility, comparison,
clean-miss fills, capacity, and the data-handling contract.

## Changing policy on a running service

New invocations resolve the current policy. A change does not evict existing
values or rewrite their stored expiration times:

| Change | Existing entries and work |
| --- | --- |
| Lower or raise the local TTL | Existing local entries keep the TTL assigned when inserted. The new TTL applies to subsequent writes. Reads do not refresh that TTL. |
| Lower or raise the remote TTL | A new Redis read classifies the frame's age using the current remote TTL. The key's physical expiration stays as written; a longer policy does not extend it or restore an expired key. |
| Change the stale-recovery maximum age | A new Redis read uses the new age policy. Existing keys keep their physical retention; shorter recovery policy restricts reuse without deleting the key. |
| Set a serving ramp to `0` | Bypass that layer without evicting its entries. A later ramp-up can reuse values that remain valid. |
| Set `requestLocal: false` | Bypass the current request's memoized values without deleting them. Re-enabling it in that scope can reuse them. |
| Change TTLs, deadlines, or recovery while a flight is active | An eligible follower can still join the existing flight and inherit its leader's execution; admitted work is not reconfigured. |
| Return Disabled-policy overlay | Stop new cache use and shadow admission. Existing flights and detached jobs can finish and publish. |

For example, reducing a local TTL from 60 seconds to 5 seconds does not make a
20-second-old local entry miss: it keeps its original 60-second lifetime. A
Redis frame of the same age is no longer fresh under a new 5-second remote TTL,
although a configured recovery policy may still admit it after a source failure.

When an immediate freshness boundary matters, account for every active layer.
A local hit bypasses the new remote age policy and the invalidation watermark.
See [Freshness boundaries](concepts.md#freshness-boundaries) and
[What followers inherit](coalescing.md#what-followers-inherit).

## Provider behavior

The provider receives the normalized [key](keys.md#the-key-passed-to-runtime-policy)
for every enabled invocation, before cache lookup or joining a flight. Each
invocation gets one policy snapshot. Keep the provider cheap; cache external
configuration reads inside it and give asynchronous work a finite deadline.

Provider errors run the loader uncached and record `config_error`; they do not
activate defaults. Invalid runtime fields fail open at the affected boundary:
for example, an invalid local TTL disables that layer while valid layers can
continue. The [native API reference](api.md) specifies validation and error types.

## Deadlines

The remote-read deadline resolves from the runtime overlay, then the operation,
then the instance, then the library default of 50 ms. It bounds the semantic
Redis read and cannot be disabled. The source deadline belongs to the operation
and defaults to 60 seconds.

Neither is a total-call budget: config resolution, codecs and writes need their
own settlement bounds. See [application-owned budgets](coalescing.md#application-owned-budgets)
and the [native API reference](api.md) for duration types and disabling the source
deadline intentionally.

## Related reference

<!-- Preserve published anchors for sections moved to their canonical pages. -->
<a id="defining-cache-operations"></a>
<a id="validation-and-snapshots"></a>

[Operation definitions and validation](api.md)
are in the API reference.

<a id="keys-ids-and-extra-dimensions"></a>
<a id="namespace"></a>
<a id="identity-rules"></a>
<a id="changing-a-namespace"></a>
<a id="provider-key-input"></a>

[Keys and identity](keys.md) covers components, namespaces, normalization, and
provider input.

<a id="constructing-keys-directly"></a>

[Direct key construction](api.md) is in the API reference.

<a id="enable-and-disable-scopes"></a>
<a id="request-local-cache"></a>
<a id="process-local-cache"></a>
<a id="cached-value-ownership"></a>

[Scopes](concepts.md#enable-and-disable-scopes), [storage lifetimes](concepts.md#three-lifetimes),
and [value ownership](concepts.md#value-ownership) are in the read model.

<a id="redis-payload-compression"></a>
<a id="coalescing-policy"></a>

[Compression](redis.md#compression) and [coalescing policy](coalescing.md#per-use-case-opt-out)
are covered by their feature references.
