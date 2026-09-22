# How DialCache works

[Documentation](index.md) · Next: [Keys and identity](keys.md)

DialCache is a read-through cache around an application function. The function
remains the source of truth. DialCache decides whether an invocation can reuse a
value and calls the function when it cannot.

## Identity governs reuse

A key combines a namespace, entity kind and id, operation name, and optional
arguments. Include every dimension that can affect the returned value.

The same identity governs both settled cache hits and in-flight sharing. A
missing tenant or locale can make callers reuse the wrong result. Turning off
coalescing does not correct an incomplete key.

A registered reader defines a reusable operation once. An inline operation
accepts a loader without registering its name. Both use the same read path. See
[Keys and identity](keys.md) for the component model and normalization rules.

## The read path

```text
Invocation
  │
  ├─ outside enabled scope ───────────────────────────────► loader
  │
  └─ enabled
       build key → resolve runtime policy
       │
       request-local → process-local → Redis / Valkey → loader
          hit?            hit?             hit?
           └───────────────┴────────────────┴────────► return value
```

Inactive layers are skipped. The first hit stops traversal, including any work
that would otherwise happen at lower layers. Same-key concurrent calls can
share work within the request before request-local lookup, and within the
instance before shared-layer lookup. With both kinds of storage enabled,
each request-local miss can join the same instance-wide flight. See
[Coalescing scopes](coalescing.md#request-coalescing).

An enabled invocation resolves one policy snapshot before lookup. Defaults
belong to the reader; the runtime provider overrides individual fields.
Outside an enabled scope, invocation skips key construction, runtime config, cache
access, coalescing, and the fallback deadline. Definition-time option validation
still happens when you create a registered reader or inline operation.

## Enable and disable scopes

Use one outer enabled scope at the request boundary. Nested enabled regions
share its request-local state; a disabled region temporarily restores
pass-through behavior without evicting values. A nested enabled region inside
a disabled one can opt a smaller region back in.

<LanguageContent language="typescript">

Enabled state follows the asynchronous call chain through Node's
`AsyncLocalStorage`, independently for each instance. `enable()` and `disable()`
restore the previous state when their callbacks settle. See the
[TypeScript guide](languages/typescript.md).

</LanguageContent>

<LanguageContent language="go">

Enabled state travels in the `context.Context` returned by `cache.Enable`.
Pass it to readers and close it with the returned `done` function. `Disable`
derives a pass-through context. See the [Go guide](languages/go.md).

</LanguageContent>

<LanguageContent language="rust">

Enabled state travels in an explicit `Scope`. Use `enable_guard` and pass its
scope to readers; dropping the guard closes it. `enable_in` and `disable_in`
derive nested scopes. See the [Rust guide](languages/rust.md).

</LanguageContent>

After the outer scope closes, new invocations through retained context are
pass-through. Already admitted cache operations can finish and publish to shared
layers, but cannot repopulate closed request-local state. An invocation still
awaiting its config provider when the scope closes skips cache lookup and runs
its loader with its enabled fallback deadline.

Keep mutation work outside the enabled boundary or inside a disabled region.
Disabling does not invalidate anything; mutable data still needs appropriate TTLs
or [targeted invalidation](invalidation.md).

## Three lifetimes

| Layer | Scope | Retention | Control |
| --- | --- | --- | --- |
| Request-local | One outer enabled scope | Until the scope closes; no capacity cap | Request-local policy |
| Process-local | One `DialCache` instance | Entry TTL and a shared LRU capacity | Local TTL and ramp; instance capacity |
| Remote | Shared Redis keyspace | Physical expiry plus logical age checks; optional watermarks | Remote TTL and ramp; connected adapter |

Create a long-lived instance per intended local-cache and coalescing boundary.
Separate instances have independent LRUs, flights, and shadow capacity, even
when they use the same Redis server.

### Request-local cache

Enabling request-local policy memoizes successful results until the outermost enabled
scope closes. State is allocated lazily. It has no TTL, ramp, capacity limit,
or eviction; keep scopes short-lived with bounded key cardinality.
A local or remote TTL does not enable request-local caching; opt into it explicitly.

### Process-local cache

One LRU holds entries across all use cases in an instance. Its capacity
defaults to 10,000 and counts entries, not object bytes. Reads update LRU order
without extending insertion TTLs.

A capacity of zero disables storage. A valid local TTL and admitted ramp still
activate that path: it misses and can coalesce concurrent calls. Use a zero
local ramp to bypass the layer, or `coalesce: false` to disable shared work.
Sequential calls with zero storage always miss this layer.

## What gets stored after a miss?

Successful results travel back through the layers that participated:

| Path | Publication |
| --- | --- |
| Request-local miss | Memoizes a successful result from the lower chain, including recovered stale values |
| Process-local miss followed by a Redis hit | Warms process-local storage with the validated value |
| Local-only or remote-disabled path | An active process-local miss can store the successful loader result |
| Untracked Redis miss | Attempts a Redis write and can store locally |
| Tracked Redis read followed by fallback | Attempts an eligible Redis refill; suppresses direct process-local publication |
| Redis read failure or timeout | Calls the loader without a Redis refill; only untracked keys can publish the fallback locally |
| Stale-on-error recovery | Returns the retained snapshot without Redis or process-local publication |

Successful empty, false, zero and null-like results are values, not misses.
Redis requires a codec that preserves the application's value meaning. The
[language guides](index.md#language-guides) explain native absence and JSON
domains; Rust maps the TypeScript undefined sentinel to JSON null.

Tracked refills can be skipped when the initial read observed a watermark that
already fences the replacement timestamp. That optimization still returns the
loader result. It is explained in [Targeted invalidation](invalidation.md).

## Freshness boundaries

A local hit does not consult Redis. Remote invalidation therefore does not
evict values already in request-local or process-local memory. A Redis hit can
also warm the local layer with a full local TTL; the remote TTL is not an
end-to-end maximum age across the chain.

Changing policy does not evict old entries. In particular, a shorter local TTL
applies to new writes; existing local values retain their insertion TTL. Redis
reads classify frame age using the current remote policy. See
[Policy changes and existing entries](configuration.md#changing-policy-on-a-running-service).

For each invocation to make its own invalidation-fence check, enable only tracked
remote caching and set `coalesce: false`. Otherwise, a caller can join work that
read Redis before invalidation and reuse that earlier observation. Invalidation
does not cancel existing flights. The watermark contract additionally depends
on bounded in-flight work, application clock skew, and preservation of watermark
state; see [Independent fence checks](invalidation.md#independent-fence-checks).

Stale-on-error deliberately permits reuse of a snapshot acquired before the
source attempt. Later invalidation does not revoke that retained snapshot.
Leave recovery disabled when that behavior is unsuitable for the data.

## Fail-open and liveness

Cache-key, configuration, and cache I/O failures generally fall through to the
loader. Loader errors still reject unless an opted-in stale-recovery policy can
serve a retained value. Explicit invalidation failures are surfaced to the caller.

Source failures are not memoized. Once a
failed flight settles, a later invocation can retry, including within the same
request-local scope. Successful stale recovery is the exception: it supplies a
value that can be memoized as described above.

Fail-open describes error handling; it does not provide a deadline for every
dependency. DialCache bounds semantic Redis reads and enabled source fallbacks
separately. Configuration providers, serializers, Redis writes, and invalidation
need finite application-owned settlement budgets. A timeout stops DialCache from
accepting late results; it does not generally cancel underlying work.

## Value ownership

In-memory values and coalesced results can share the same underlying value.
DialCache does not deep-clone or freeze application data. Treat reused values as
immutable; copy before mutation. Redis deserialization creates a native value,
so reference identity is not a portable API guarantee.

<LanguageContent language="typescript">

Objects are shared JavaScript references. The wrapper preserves the source's
resolved value type; [typed serializers](redis.md#typed-serializer-requirement)
are required for statically non-JSON-compatible values.

</LanguageContent>

<LanguageContent language="go">

Generic results follow Go assignment semantics. Maps, slices and pointers may
still share mutable backing data; returning a struct does not make those fields
independent. Use a `Codec[T]` for remote values outside the default JSON domain.

</LanguageContent>

<LanguageContent language="rust">

Results are `Arc<T>`, including coalesced results. Keep one value type per cache
identity: a settled memory entry of another type misses, while an incompatible
coalesced follower returns a type error. Interior mutation can affect other
callers, even through a shared `Arc`.

</LanguageContent>

## Where to go next

- [Keys and identity](keys.md) defines results and invalidation groups.
- [Configuration and rollout](configuration.md) explains defaults and overlays.
- [Coalescing and liveness](coalescing.md) explains flights and deadlines.
- [Redis and Valkey](redis.md) explains the remote layer and client contract.
- [API reference](api.md) provides method and option lookup.
