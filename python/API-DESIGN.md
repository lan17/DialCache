# Python API design and gcache lineage

The Python binding was designed after reviewing [rungalileo/gcache at a688049](https://github.com/rungalileo/gcache/tree/a68804986782cb0b7e8b7dc6bfc34c718c177189), including `src/gcache/gcache.py`, `config.py`, `proto_serializer.py`, and the context, layer wrappers, local cache, Redis cache, and event-loop thread implementations under `_internal/`.

DialCache's [Quint specification](../formal/SPEC.md) and TypeScript implementation define portable behavior. Gcache supplies useful Python interface ideas; its implementation is not a compatible DialCache backend.

The primary decorator style selects identity explicitly with
`cache_key=lambda user_id, locale: {"id": user_id, "args": {"locale": locale}}`
and a stable `use_case`. This follows TypeScript's `cacheKey` while retaining
Python decorator syntax. The selector makes result dimensions and their wire
names explicit; it must include every input that affects the result.

Selectors receive the loader's original `*args` and `**kwargs`. Match parameter
names and defaults so positional, keyword, and omitted-default calls select
the intended identity. Loader defaults are not injected into the selector;
changing that behavior could change existing keys or break existing callbacks.

| Gcache interface or behavior | Python DialCache decision |
| --- | --- |
| `with cache.enable(enabled=True)` | Retained, with per-instance context variables and explicit outer-scope lifetime. Also supports `async with` and `disable()`. |
| `@cache.cached(key_type=..., id_arg=...)` | Supported alternative to explicit `cache_key` selection. `id_arg` can be a parameter name or `(name, adapter)` pair. Signature binding includes defaults. |
| `arg_adapters`, `ignore_args`, inferred use case | Inferred argument controls remain supported. Default use-case names include module and qualified function name; prefer explicit names for stability across refactors and languages. Argument names use the portable UTF-16 ordering and scalar normalization. |
| Direct `aget(key, fallback)` | Retained as a structured-key convenience; `get_or_load` is the primary inline-loader API. |
| `ainvalidate` | Retained as an alias for `invalidate_remote`; missing Redis and failed mutations raise. |
| `GCacheKeyConfig` and per-use-case provider | `Policy` / `DialCacheKeyConfig` use sparse per-leaf inheritance and deterministic per-key cohorts. `Policy.enabled(ttl_sec)` is available. |
| Async `Serializer.dump/load` | Retained; synchronous implementations are also accepted. Default JSON supports the portable top-level `UNDEFINED` value. |
| Synchronous wrapper and background event-loop pool | The binding is asyncio based. Every cached wrapper is awaitable; synchronous loaders execute on the caller's event loop. One cache belongs to one event loop. No implicit threads or client factories are created. |
| Singleton, global namespace, global metrics | Instances own their namespace, request scopes, local capacity, flights and observer. The application owns its Redis client. |
| Pickle / JSON / protobuf envelope choice | DialCache always uses the portable version-1 frame and compression wrapper. A custom serializer can produce text or binary payloads, including protobuf. There is no pickle fallback or gcache envelope compatibility. |
| `aput`, `adelete`, `aflushall` and their synchronous counterparts | These are not part of the existing DialCache public contract and are not added by this port. Tracked invalidation is the explicit maintenance API. |
| Random sampling and per-use-case local TTL cache | Replaced by DialCache's deterministic key cohorts and a bounded per-instance LRU, with expiry captured at each insertion. |

Disabled calls bypass key selection, argument adaptation, policy resolution, deadlines and coalescing. Redis reads acquire the value and watermark atomically from a primary; writes use one native `SET` of a complete frame. None of these rules are inherited from gcache's implementation.

Method decorators omit `self` from inferred key arguments by default. An explicit
`arg_adapters={"self": ...}` includes the adapted instance identity, for example
its tenant ID. `ignore_args` takes precedence over argument adapters.

The Python API is a binding of the existing behavior, not a migration that reads existing gcache keys or envelopes. Applications sharing entries across ports must use the same namespace, entity identity, use case, argument order and payload schema.
