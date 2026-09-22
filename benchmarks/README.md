# Shared port benchmarks

This suite measures equivalent public API workloads in TypeScript, Go and Rust.
TypeScript is the behavior reference; each port's performance baseline is its
own previous revision. Timings are informational, not conformance thresholds.

## Run and compare

From the repository root, install the pinned toolchains and dependencies as
described in [the maintainer guide](../docs/maintainers.md), then run:

```sh
corepack pnpm benchmark --suite core
corepack pnpm benchmark --suite redis
corepack pnpm benchmark --ports go,rust --suite all --samples 5
corepack pnpm benchmark --suite all --cases redis-write-100b,redis-write-1m
corepack pnpm benchmark:test
```

The default selects all three ports and five fresh process samples per case.
Workers run sequentially, rotating port order between samples. Compilation
happens first. Redis suites start and remove their own loopback-only Docker
`redis:6.2` server. `--redis-url redis://host:port/db` instead uses an existing
**dedicated** server; concurrent traffic contaminates global command counters.
The suite deletes only its own unique keys. Redis credentials are not saved.

Results go to ignored `.bench-results/` or a new path supplied with `--output`.
Artifacts preserve raw repetitions, operation latency samples, behavior counters,
workload parameters, commit/dirty status, runtime/compiler versions and host/Redis
metadata. Keep the machine idle and use the same power/CPU settings between runs.
Use clean committed trees for reproducible baseline comparisons.

```sh
corepack pnpm benchmark --suite core --output .bench-results/base.json
# Change revision, keeping toolchains, machine and experiment settings fixed.
corepack pnpm benchmark --suite core --output .bench-results/head.json
corepack pnpm benchmark:report .bench-results/head.json .bench-results/base.json
```

Comparison matches cases within each port and rejects changed workloads,
toolchains, recorded hosts, Redis endpoints or smoke/full profiles. It reports
median change, not a timing pass/fail gate. Cross-port tables are diagnostic:
idiomatic public API costs and runtime value ownership differ between languages.
Core rows show median batch nanoseconds/operation and the min–max across processes;
coalescing rows show nanoseconds/burst. Redis p50/p95 use actual per-operation
samples pooled across repetitions, not percentiles of batch averages.

`--smoke` runs tiny cases and one sample to validate execution and behavior. It
uses the existing Rust development build to keep CI fast; its numbers are not
performance evidence and cannot be compared with full optimized runs. Normal
runs use built TypeScript, standard Go builds and Rust's release profile. The
existing TypeScript-only benchmark commands and Go internal microbenchmarks
remain available for native diagnostics, including shadow and stale recovery.

## Worker contract (version 1)

One native process receives one JSON request on stdin and emits one JSON result
on stdout. Diagnostics go to stderr; failures exit nonzero. Setup, compilation,
JSON parsing/output and Redis connection establishment are outside timed work.

Request:

```json
{"version":1,"id":"unique-sample-id","case":{"id":"request-local-hit","kind":"request-local-hit","suite":"core","scope":"single","iterations":20000,"warmup":2000,"fanout":1,"capacity":128,"payloadBytes":32},"payload":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx","redisUrl":null}
```

All case fields are required. The runner supplies an ASCII `x` payload of exactly
`payloadBytes` bytes. Keys are precomputed outside timing. Use the real clock and
production runtime, one worker (Go GOMAXPROCS=1, Rust current-thread Tokio), no
compression, no logging or metrics exporter. Coalescing cases alone use a minimal
observer to count followers and establish that every follower joined its flight.
Use the normal 60-second source deadline, 3600-second cache TTLs and the supplied
local capacity. Do not reuse the controlled clocks/runtimes of formal drivers.
The Redis read deadline is 60 seconds. Single enabled scopes are established
before timing; per-operation/per-burst scopes are created and closed inside it.
The disabled case configures request-local caching but enters no enabled scope.

Core keys use namespace `urn`, key type `benchmark-key`, use case `Benchmark`,
and ID `shared` for sequential hits/baselines. Eviction prefills `prefill-N` and
measures `key-N`; bursts also use a new `key-N` per burst. Redis phases use
namespace `benchmark-<request id>-warmup` or `benchmark-<request id>-measured`,
the same key type/use case and ID `shared`; raw writes repeatedly overwrite
`<namespace>:write` with binary payloads. All ports reuse one Redis connection
between warmup and measurement, with fresh phase caches and keys.

Run the warmup first, then a fresh measured phase with its own cache/scopes/keys.
Priming/prefilling is outside timing. Reset measured counters after priming.
Every source returns the supplied string. Consume every result's byte length in
a checksum during timing; validate full returned content outside timing. Source
and follower counters remain active during timing. Measurements include public
API key construction, policy resolution and the scope boundaries below.
Preallocated arrays retain returned values for complete validation after timing;
the checksum uses string length, which equals bytes for the supplied ASCII data.
This small result-recording cost is included in all ports, including the source
baseline. The 64 KiB read cases retain about 32 MiB of payloads per measured
phase; these are bounded workloads, not memory-footprint benchmarks.

| Kind | Scope and measured work | Expected measured source calls |
| --- | --- | --- |
| source-baseline | none; directly await the source once per iteration | iterations |
| disabled | none; configured request-local operation outside an enabled scope | iterations |
| enabled-uncached | single enabled scope; no active cache layers | iterations |
| request-local-hit | single scope; prime one key in that same scope, then hits | 0 |
| process-local-hit | fresh enabled scope per call; prime process-local entry | 0 |
| local-eviction | fresh scope per call; prefill capacity, then distinct new keys | iterations |
| request-coalescing | one fresh shared scope per burst, one new key per burst | iterations |
| process-coalescing | fresh scope per caller, one new key per burst, local caching | iterations |
| redis-hit | fresh scope per call, remote only; prime one untracked key | 0 |
| redis-tracked-hit | as redis-hit, with tracked reads | 0 |
| redis-write | none; native public adapter writes the supplied raw bytes | 0 |

For coalescing, iterations counts bursts, each with `fanout` concurrent callers.
Hold the source until all `fanout - 1` followers have joined, then release it and
await all callers. No artificial source delay. Report burst completion time,
not sustained throughput. Everything inside a burst, including task/scope
creation and coordination, is timed. Bound gate waits so broken cases fail.
Eviction cases additionally verify cached prefill before timing, and verify that
the newest measured key hits and oldest prefill key misses afterward. These
probes are outside measurement and excluded from reported counters.

Redis cases use a dedicated disposable server. Each phase uses unique keys and
cleans them up. Count adapter reads/writes for the measured phase. Snapshot
`INFO commandstats` before and after measured work (outside timing) and return
deltas for get, mget, set, eval, evalsha and time. Do not reset global statistics.
Write cases require exactly one SET per operation, zero scripts and zero TIME.
Redis cases additionally time each complete operation with a monotonic clock;
return raw latency samples in nanoseconds. All core cases time the entire batch.

Result shape (all fields required; latencyNs is empty for core):

```json
{"version":1,"id":"unique-sample-id","port":"typescript","caseId":"request-local-hit","operations":20000,"elapsedNs":1000000,"checksum":640000,"valueValid":true,"counters":{"sourceCalls":0,"redisReads":0,"redisWrites":0,"coalescedCalls":0},"redisCommands":{"get":0,"mget":0,"set":0,"eval":0,"evalsha":0,"time":0},"latencyNs":[],"runtime":{"version":"v24.13.1","workers":1}}
```

Operations is iterations, or iterations times fanout for coalescing. Checksum is
operations times payloadBytes. Redis hits require one adapter read per operation;
adapter writes require one write per operation. Other measured adapter counters
are zero. Coalescing requires iterations times (fanout - 1) coalesced callers.
Invalid requests, unknown cases or failed behavior checks must fail explicitly.

## Layout

The catalogue and orchestration live here. Native loops live in
`typescript/scripts/benchmarks`, `go/cmd/dialcache-bench`, and
`rust/benches/dialcache`. Each worker uses its port's public API. Keep the catalogue
declarative; a new workload gets a named implementation in each native worker.
Language-specific microbenchmarks and diagnostics can remain beside their port.
