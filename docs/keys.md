# Keys and identity

[Documentation](index.md) · Next: [Configuration and rollout](configuration.md)

A DialCache key identifies the result a caller can reuse. It also determines
which concurrent calls can share a loader. For tracked Redis values, part of
that identity groups the results affected by one invalidation:

```text
namespace + keyType + id  → invalidation group
          + useCase + args  → result identity
```

## Anatomy of a key

Consider a tracked user lookup in two locales:

```text
{users-api:user_id:123}?locale=en#GetUser
{users-api:user_id:123}?locale=fr#GetUser
└─────── entity ──────┘└─ args ─┘└ useCase
```

These are different cached results for the same entity. Another operation,
such as `GetPermissions`, has its own entries under that entity too.
Invalidating entity kind `user_id` and id `123` advances one watermark covering
all of those tracked results within the instance's namespace.

| Component | Role | Example |
| --- | --- | --- |
| `namespace` | Application or environment partition, set on the instance | `users-api` |
| `keyType` | Entity kind | `user_id` |
| `id` | Entity identity within that kind | `123` |
| `useCase` | Stable name for the operation and its result meaning; also a metric label | `GetUser` |
| `args` | Additional dimensions that change the result | `locale=en` |

The braces mark a Redis Cluster hash tag. Tracked result keys and their watermark
share a slot so Redis can read them atomically. Untracked keys omit the braces
and never consult the watermark. Redis value keys append `:dialcache-frame-v1`
to the logical keys shown here; see [storage format](redis.md#advanced-wire-protocol).

## Define a result identity

A registered reader selects an entity id and additional arguments from its
source inputs. An inline operation supplies that identity directly.

<LanguageContent language="typescript">

For `cached()`, `cacheKey` receives the loader's parameters and returns a bare id
or `{ id, args }`. `getOrLoad()` accepts the same shape directly as `key`.
This API excerpt assumes an application `db`:

```ts
import { CacheLayer, DialCache, DialCacheKeyConfig } from "dialcache";

const dialcache = new DialCache({ namespace: "users-api" });
const getUser = dialcache.cached(
  (userId: string, locale: string) => db.fetchUser(userId, locale),
  {
    keyType: "user_id",
    useCase: "GetUser",
    cacheKey: (userId, locale) => ({ id: userId, args: { locale } }),
    defaultConfig: new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.LOCAL]: 60 },
    }),
  },
);

await dialcache.enable(() => getUser("123", "en"));
```

</LanguageContent>

<LanguageContent language="go">

`Cached` takes an `Operation[T]` and a key selector returning `Identity`.
Set the entity kind and use case in `Operation.Identity`; return the entity id
and normalized argument pairs from the selector. For a user-and-locale lookup,
use the user id as `ID` and locale as an `Args` dimension. Use `NormalizeArgs`
when constructing pairs from JSON-shaped scalars. See the [Go guide](languages/go.md).

</LanguageContent>

<LanguageContent language="rust">

The `use_case` builder supplies entity kind and use case. Its `key` callback
returns a `KeySpec`; use `KeySpec::new(id).arg("locale", locale)` for a
user-and-locale lookup. An inline `Operation<T>` carries an `Identity` directly.
See the [Rust guide](languages/rust.md).

</LanguageContent>

Include every input that can change the result. Omitting an authorization scope,
tenant, or locale can make callers reuse the wrong value. Disabling coalescing
does not fix an incomplete key. Add a Redis client, remote policy and tracked identity to use
[targeted invalidation](invalidation.md).

All call sites sharing a key must agree on value meaning and serialization.
Keep use-case names stable and bounded; put entity and request dimensions in
`id` or `args`. Registered readers reserve each name once per instance;
inline operations do not register names. Both reserve `"watermark"`.

Inputs omitted from the key still reach the loader, but a cache hit can skip
that loader and a coalesced caller can inherit another caller's execution.
For inputs such as a database handle or cancellation signal, make sure both value
reuse and [shared execution](coalescing.md#what-followers-inherit) are valid.
Snapshot mutable arguments or captured state before invoking an operation whose
[shadow loader](shadow-validation.md) may run after the caller continues.

## Normalization and encoding

Normalized scalar identity is string-based. Argument names use UTF-16 ordering
so ports construct the same key. Undefined/absent argument values are omitted:

| Inputs, with other components equal | Identity |
| --- | --- |
| Numeric id `1` or string id `"1"` | Same key |
| Null argument or string `"null"` | Same key |
| Argument negative zero or zero | Same key |
| Absent argument or no such argument | Same key |
| Argument records with different property order | Same normalized key |

If a scalar's meaning changes, change an explicit identity dimension such as
entity kind, use case or an argument name/value. Large integers must retain their
exact spelling; do not pass an already-rounded floating-point number when the
original integer matters.

Components use percent encoding compatible with JavaScript `encodeURIComponent`,
so delimiters inside values do not become structural separators. Namespace
braces are rejected; tracked entity kinds and ids also reject braces. Untracked
kinds and ids may contain encoded braces. Automatic key-construction failures
follow the [fail-open path](concepts.md#fail-open-and-liveness).

<LanguageContent language="typescript">

`cached` and `getOrLoad` normalize ids and args automatically. Direct
`DialCacheKey` construction preserves supplied pair order; call `normalizeArgs`
when needed. Bigint ids retain exact integer spelling. Namespace brace errors
are `TypeError`; tracked kind/id brace errors are `Error`.

</LanguageContent>

<LanguageContent language="go">

`Identity` takes string ids and ordered argument pairs. `NormalizeArgs` applies
the shared scalar spelling and sorting rules; `Absent` omits a dimension.
Use normalized pairs consistently when constructing identities directly.

</LanguageContent>

<LanguageContent language="rust">

`IntoKeyId` preserves exact primitive integer spelling, converts floats with
JavaScript-compatible formatting and accepts string IDs. `KeySpec::arg` accepts
primitive scalars; `normalize_args` handles the shared ordering and omission
rules. `f32` is promoted to `f64` before formatting.

</LanguageContent>

See the [native API reference](api.md) for direct key construction.

## Namespace

The instance namespace defaults to `"urn"`. Set an application-specific
value when applications or environments share Redis. It partitions all cache
layers, coalescing, ramp cohorts, and invalidation, and appears in metrics.
Use a stable, bounded name.

### Changing a namespace

Changing `namespace` intentionally creates a cold-cache boundary across every
layer. Old and new keyspaces do not share Redis values or invalidation
watermarks.

During an overlapping deployment, an invalidation handled by one version is
invisible to the other. The other version can continue serving a stale tracked
value until its value TTL expires. If remote invalidation correctness matters,
a normal rolling namespace change is unsafe.

Use a coordinated no-overlap cutover, or an operational bridge that prevents
both versions from serving remote cache across mutations. For example,
temporarily disable and clear remote caching during the transition. After the
cutover, provision for fallback and refill load, and allow old Redis keys to
expire by TTL.

## The key passed to runtime policy

The provider receives the normalized result identity before lookup or joining
a flight. Select policy from the namespace, entity kind/id, use case and argument
dimensions without mutating them.

<LanguageContent language="typescript">

The read-only `DialCacheKey` additionally exposes `prefix` (encoded entity
prefix), `urn` (complete logical key), `defaultConfig`, `serializer`, and
`trackForInvalidation`. Its id is already a string and its args are sorted pairs.

</LanguageContent>

<LanguageContent language="go">

The provider receives `context.Context` and a normalized `Identity`.
`Identity` carries namespace, entity kind/id, use case, ordered args and tracking;
the operation's baseline is already known to the cache during policy resolution.

</LanguageContent>

<LanguageContent language="rust">

The provider receives the normalized `Identity`. It includes namespace, entity
kind/id, use case, ordered args and tracking; return a sparse `RuntimePolicy`
without rebuilding the operation's baseline.

</LanguageContent>

See [runtime overlays](configuration.md#baseline-and-overlay-precedence).
