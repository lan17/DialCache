# Bounded Go reference

This is an experimental second-language implementation and test driver for
**core profile version 1**, specification **0.1.0**. It is not a production
release or a complete DialCache port. Its purpose is to make the portable
contract executable without the TypeScript implementation or its driver.

The implementation was written from the formal documents, Quint models, and
portable vectors. Its author had previously reviewed TypeScript code in this
task, so this is **not a clean-room provenance claim**. Implementation and
execution use only Go's standard library. Go does not call Node, TypeScript,
Vitest, or Quint during replay; Quint only produces the shared input corpus.

## Supported behavior

`Cache[T]` executes actual concurrent calls through `Enable`, `Disable`,
`GetOrLoad`, and `Invalidate`. Explicit contexts identify per-instance request
lifetimes. Mutexes and completion channels protect request memoization,
process-local storage, and registered request/process flights. The semantic
`Remote` and `Codec[T]` interfaces supply external effects. `Identity` accepts
an explicit namespace and already normalized ordered string arguments.

Codecs encode and decode `Payload{Bytes, Binary}`. The tag survives publication
and remote reads: text follows replacement UTF-8 rules, while binary data
retains every byte. A public remote roundtrip regression uses invalid-UTF-8
binary data and checks exact returned bytes, the codec's received tag, and
one source invocation across two calls.

`Policy` is a **resolved static policy** expressed in milliseconds, not a raw
runtime configuration API. The driver supplies the core profile's 60-second
TTLs, 10,000 local capacity, tracked remote identity, and default sharing.
`Options.LocalCapacity` is explicit; zero disables storage and retains sharing.
Local TTL/LRU and nested/closed context ownership are implemented, but the core
profile only claims the schedules described in `../CONFORMANCE.md`. Two small
public-API tests additionally exercise scope closure/replacement and nested
disable/reenable; they do not constitute passing the generated scope profile.

Every core action is supported:

| Action | Public/environment execution |
| --- | --- |
| `init` | Fresh cache, source, counters, clocks, and semantic remote |
| `bumpSource` | Increment only the external source value |
| `outsideCall` | Call without an enabled context |
| `requestLocalPair` | Two sequential calls in one enabled lifetime |
| `localCall` | Enabled local-only call |
| `coalescedLocalPair` | Concurrent calls with a controlled source gate |
| `remoteCall` | Enabled tracked remote-only call |
| `invalidateRemote` | Public invalidation; the adapter advances its fence |
| `remoteReadFailureCall` | Fail the raw read; observe source return and no refill |

The in-memory remote is an external adapter fixture. It atomically reads frames
and watermarks, preserves physical expiry separately from application wall time,
and stores frames through the Go codec. Its counters record actual calls, even
failed reads. It does not implement or establish the real Redis/Lua invalidation
retention protocol. Existing bytes may remain present after fencing.

The driver accepts only action names as execution input. Expected ITF state
never sets cache values, source values, effects, clocks, or counters. After each
action, the assertion layer compares returned values, actual source invocations,
and actual adapter invocations. Model-private cache fields are not observations.
A negative harness test acknowledges writes while discarding them, requiring a
later public read to diverge; another corrupts expected observations and must
fail without changing execution.

For a cold concurrent pair, the leader's source remains blocked until the actual
public coalescing observer reports a follower, or a second actual loader exposes
lost sharing. For a warm pair, the first completed public result establishes
progress. There are no guessed goroutine turns or scheduling sleeps. A five-second
watchdog covers the whole pair, including both final results after source
release, and reports deadlock with the failing trace action; it never determines
a successful schedule.

## Protocol groups

The following complete groups from `protocol-vectors.json` schema 3 run against
the Go implementation. Counts describe the committed corpus, and tests report
the actual group counts each run.

| Supported group | Cases | Boundary |
| --- | ---: | --- |
| `keyVectors` | 8 | Ordered identities, percent escaping, tracked hash tags |
| `invalidKeyVectors` | 6 | Reserved delimiters and isolated-surrogate rejection |
| `frameVectors` | 8 | Complete version-1 bytes and payload text conversion |
| `trackedDecodeVectors` | 38 | Atomic reply classification, fences, encoding precedence |
| `untrackedDecodeVectors` | 18 | Frame classification without watermark semantics |
| `rampVectors` | 15 | Exact FNV-1a cohorts over UTF-16 code units |
| **Supported total** | **93** | Finite cases, not exhaustive protocol proof |

Text decoding follows `../PROTOCOL.md`: replacement UTF-8 per maximal ill-formed
subpart, preserving BOM and noncharacters. Binary payloads retain exact bytes.
Go's scalar-string boundary rejects isolated-surrogate key JSON before the
standard JSON decoder could replace it. Payload JSON instead converts isolated
surrogates to U+FFFD. The decoder retains uint64 timestamps exactly; core refuses
unsafe timestamps before deserialization. Frame writes reject unsafe unsigned
timestamps; negative and fractional timestamps cannot enter that typed API.

**Unsupported protocol groups:** `normalizeArgsVectors`,
`invalidTimestampVectors` (the complete fixture numeric-domain group),
`envelopeVectors`, `compressedDecodeVectors`, `compressionWriteVectors`,
`durationVectors`, and every `invalidation-vectors.json` transition. Supporting
ordinary core invalidation does not imply supporting that transition suite.
There is no compressed-entry, envelope, real Redis, Valkey, or Cluster claim.

## Running and reporting

From this directory, with the CI-pinned Go **1.27.1** toolchain:

```sh
go test -race -v ./...

DIALCACHE_MBT_TRACE_DIR=/absolute/path/to/.formal-traces/conformance \
  go test -race -count=1 -v ./...

DIALCACHE_MBT_TRACE_FILE=/absolute/path/to/trace_0.itf.json \
  go test -race -count=1 -run TestCoreConformance -v ./...
```

Without a trace override, the committed core smoke always runs. Directory mode
requires a nonempty corpus and every named core action. File mode supports
focused reproduction. The parser rejects unknown actions, missing/misplaced
initialization, unsupported action arguments, missing observations, unsafe ITF
integers, duplicate JSON members, empty traces, and initialization without an
actual transition. `profiles.json` schema 1,
specification version 0.1.0, core version 1, and protocol schema 3 are checked
before replay. Incompatible versions fail visibly.

A result must name the repository revision, Go version, profile version, exact
corpus/seed/bounds, and passing vector groups. `-race` checks Go's exercised
concurrency; it is not an exhaustive schedule proof. Passing core gives no
effects/scope/recovery/policy/shadow/admission/layers/independent-profile claim.

Missing behavior includes runtime providers and malformed runtime-policy
resolution, read/source/shadow deadlines and cancellation, stale recovery,
shadow validation, compression/envelopes, the behavioral-scenario driver,
portable diagnostic schemas, real remote integration, connection management,
and complete static configuration validation. The API uses explicit Go errors;
source/codec panics and platform resource exhaustion are outside this bounded
reference. Production use requires those contracts and independent review.

## Specification questions resolved

The surrounding specification review and Go implementation made these
boundaries explicit:

- **C16, null policy inputs.** A whole-provider null reply inherits the
  operation policy; an explicit null leaf is supplied invalid data. This
  clarification came from the earlier specification review. The Go reference
  accepts resolved static policy and does not claim runtime-policy conformance.
- **C31, tracked local publication.** Suppression depends on participating in
  the tracked remote serving path. A tracked identity with only local serving
  still publishes locally. This exception was also identified in the earlier
  review; the Go implementation preserves it.
- **W04, text decoding and payload type.** Text needs maximal-subpart UTF-8
  replacement with BOM preservation; binary must retain exact bytes. Protocol
  review added shared vectors, which the Go decoder consumes. Review of the Go
  API then required carrying the encoding tag through both codec directions.
- **C18, request admission.** Eligible request coalescing precedes request memo
  lookup, just as process coalescing precedes shared-layer lookup. This matters
  when an independent execution has populated a memo while an older eligible
  flight remains registered. Specification review clarified this ordering;
  the Go reference implements it, though that mixed schedule remains outside
  the core profile's generated evidence.
