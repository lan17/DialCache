# Go Redis-write and policy-provider budgets

- **Status:** Implemented
- **Issue:** none
- **Pull requests:** #255
- **Baseline:** `main` at `a75623ed01596ded5ec96f3c1b3c2ef6ab323e3a`, the commit the record was written against
- **Supersedes:** none; both decisions keep the liveness boundary in [#69](https://github.com/lan17/DialCache/pull/69)

## Context

All repository file:line citations below refer to the baseline above.

Two requests made together with the Go source-context fix change existing
decisions, not just implementation details: bounding Redis mutations inside
the library, and bounding policy resolution while falling back to static
caching policy. Reversals require a record and maintainer approval before
implementation (`AGENTS.md:32-33,69-70`), so the pull request that carries the
source-context fix carries this record with both decisions Open and implements
neither request.

That fix detaches a coalesced flight from its leader's cancellation; each
caller still owns its wait. Consequently, cancellation of one caller does not
stop the flight's later SET, which is then bounded only by the Redis client's
own budgets.

## Proposal

Accepted: retain application-owned mutation and provider budgets, document
them, and leave both requested contract changes unimplemented. No new
TypeScript or Go option is added. D1 and D2 below record the maintainer's
choices and the alternatives that lost.

## Out of scope

Source-context cancellation, the detached shadow context, and the Redis
pool-wait read regression are native Go binding fixes in the same pull request
that keep their existing obligations; this record does not decide them. This record does not
propose admission control, automatic flight eviction, retrying ambiguous
mutations, or a last-known-good policy cache; each needs separate semantics
and evidence.

## Contract and model changes

The recommended choices leave portable contracts, Quint models and profiles
unchanged: C26 retains application ownership, C20 retains uncached fail-open,
and C18 still resolves policy once per enabled invocation.

If D1's portable alternative is approved, revise C26 and specify mutation
wait expiry, late completion, and ambiguous outcomes, preserving C29's
surfaced maintenance errors (`formal/guides/CONTRACTS.md:72-75`). Extend
`formal/models/dialcache-effects-conformance.qnt` for mutation liveness and
`formal/models/dialcache-shadow-conformance.qnt` for shadow fill/maintenance;
add regressions for held SET, shadow fill and invalidation, including late
settlement. Socket deadlines and connection disposal remain native adapter
details, not portable cancellation guarantees.

If D2's portable alternative is approved, revise C20/C26, retain C18's
single-resolution snapshot, and extend
`formal/models/dialcache-policy-conformance.qnt` with pending-provider expiry,
static fallback on error, and ignored late overlays. Regressions must cover
timeout, failure, retained entries and concurrent policy changes. Rewrite the
existing provider-failure scenario and replay it in every port. A Go-only
exception also needs an explicit contract/profile decision, not a silent
test exclusion.

## Decisions

### D1. D-A: Who owns Redis value-write and invalidation deadlines?

- **Choice:** Option 1, retain application ownership.
- **Status:** Confirmed 2026-11-11 by the maintainer in session: “Application
  owns Redis deadlines. We should make that clear in the docs if its not
  already. Some features support optional deadlines but thats it. Exception is
  remote read timeout option you can provide in config. If we want more
  deadlines in future we will add this to the cache key config/dialcache
  instance config, but lets not do this now.”
- **Rejected:**
  - Option 2: a Go-only deadline reverses C26/#69 and creates a parity
    exception without bounding underlying socket work.
  - Option 3 is deferred, not ruled out: a future Redis deadline goes into the
    per-operation policy or the instance configuration, and needs an approved
    outcome/late-write contract and cross-port implementation.

**Context.** C26 explicitly says “config, decoding, accepted
serialization/write have application-owned budgets”
(`formal/guides/CONTRACTS.md:72`). #69's **Liveness boundary** says
“DialCache does not claim to cancel or time-bound Redis, serializers,
configuration providers” and requires injected boundaries to settle within
an application-defined budget. The miss-path write forwards `x.ctx` without
a separate library write budget (`go/engine.go:536-538`); shadow fill uses
that same helper (`go/shadow.go:239-248`). The adapter sends one native SET
(`go/redis_adapter.go:106-122`). Invalidate forwards its caller context and
returns the remote error (`go/cache.go:187-190`).

TypeScript is version 0.27.0 (`typescript/package.json:3`). Its Redis option
shape has a read timeout but no write or invalidation timeout
(`typescript/src/internal/redis-cache.ts:38-57`); its semantic client requires
application-owned resource budgets and warns about ambiguous dispatched
commands (`typescript/src/redis-client.ts:159-168`).

**Options and consequences.**

1. **Keep application-owned.** Document finite go-redis `WriteTimeout` and
   `ReadTimeout` (a SET also waits for a reply), plus connection/retry/queue
   budgets. Invalidate callers supply their own context and must configure
   their client to honor the intended budget. After flight detachment,
   value writes rely on the client's budgets, not the departed caller's
   cancellation. A custom Remote must supply its own finite settlement.
2. **Go-only instance option.** Add, for example,
   `WithRemoteWriteTimeout(time.Duration)`, mirroring
   `WithRemoteReadTimeout` (`go/api.go:266-276`), to bound waits for miss SET,
   shadow fill SET and Invalidate. Use a cancel-only child context and a
   separate wait timer; do not install a context/socket deadline. This
   returns control without proving cancellation or preventing late mutation.
   Cache writes remain fail-open; maintenance timeout must surface an error.
   Default, disabling behavior and late-write/publication rules need approval.
3. **Portable setting, TypeScript first.** Define a write/mutation timeout
   setting in the reference API, then mirror it in Go, Rust and Python.
   This maintains parity but changes C26/#69 and requires the model and replay
   work above. Naming must make clear whether invalidation shares the budget.

**Transport risk.** Do not substitute `context.WithTimeout` and call it only
a wait bound: with go-redis `ContextTimeoutEnabled`, a context deadline can
become a socket deadline; socket timeout causes connection removal/closure.
The baseline pins go-redis v9.22.0 (`go/go.mod:9`); that dependency's
`options.go:173-175`, `redis.go:1468-1473`,
`internal/pool/conn.go:1045,1084,1207-1225`, and
`redis.go:1048-1051` show context selection, deadline propagation and removal.
A dispatched mutation may still have executed. Cancel-only waiting avoids
adding that socket deadline, not all connection churn or resource lifetime.

### D2. D-B: Should provider failure or timeout use static caching policy?

- **Choice:** Option 1, retain the contract and document an application
  wrapper.
- **Status:** Confirmed 2026-11-11 by the maintainer in session: “yes
  provider failures should fail open to teh caller. The only side-effect to
  caller is that non-cached value is returned. We do need to make sure we
  instrument such failures consitently tho”. Every port logs a warning and
  records a `config_resolution` error and a `config_error` skip on the `noop`
  layer before running the source uncached (`typescript/src/dialcache.ts`,
  `python/dialcache/cache.py`, `rust/src/execution.rs`, `go/engine.go`).
  #255 adds a Go regression for those signals. The shared scenario checks
  only calls and loaders, so cross-port event parity is a follow-up.
- **Rejected:**
  - Option 2: static caching during a provider outage may defeat a rollout
    or emergency disable, and the caller should see only an uncached value.
  - Option 3 is not recommended: a Go-only fallback breaks portable behavior
    and existing provider-failure replay expectations.

**Context.** C18 resolves policy once per enabled invocation; C20 says
“Provider failure uses uncached source, not baseline caching”; C26 makes
configuration budgets application-owned
(`formal/guides/CONTRACTS.md:64-72`). Go invokes the provider before cache
admission, catches errors/panics through `callSafely`, and returns uncached
source on failure (`go/engine.go:117-135`). TypeScript does the same
(`typescript/src/dialcache.ts:527-535`) and explicitly adds no provider
deadline (`typescript/src/config.ts:208-212`). Thus a slow provider delays
even would-be hits, and persistent failure directs calls to source.

A reported run increased source traffic from zero to about 1,000 calls/s
during provider failure. Its commit and workload were not supplied and the
measurement was not reproduced; it is motivation, not baseline benchmark
evidence or a sizing guarantee.

The exact scenario “provider failure fails open without caching” exists at
`formal/catalogs/behavioral-scenarios.json:237-245`. Go loads that corpus
(`go/behavior_replay_test.go:11-13`) and normally replays every scenario
(`go/behavior_replay_test.go:79-94`); its provider fault returns an error
(`go/behavior_driver_test.go:467-475`). Static fallback would retain the
first result and fail the scenario's second-call expectation. Quint also
tests bypass and preservation of pre-existing local entries
(`formal/models/dialcache-policy-conformance.qnt:517-524`).

**Options and consequences.**

1. **Keep the contract; application wrapper.** The wrapper applies its own
   deadline, handles failure/panic, and deliberately returns a nil overlay
   with no error to inherit static policy (`go/api.go:324-327`). It must
   actually settle within its budget, even if the upstream provider ignores
   cancellation, and observe/log the failure. This preserves library
   semantics and makes outage caching an explicit application policy; late
   work still needs resource management.
2. **Change C20/C26 across ports.** Define a provider deadline and static
   fallback in TypeScript first, update Quint and shared scenarios, then
   Rust, Python and Go. Preserve one resolution and one accepted policy
   snapshot per enabled call. Budget defaults, panic handling, observability
   and late-overlay rejection must be decided before implementation.
3. **Go-only deviation.** Add a provider timeout/fallback only in Go.
   This changes outage behavior by language, violates C20/C26, and fails
   existing replay expectations unless a separately approved conformance
   exception changes them. It is not a Go bug fix.

## Impact

The recommended choices require application-budget guidance in
`go/README.md` and `docs/languages/go.md`, with affected documentation pins
reviewed and refreshed. No API migration or generated behavioral changes.
Portable alternatives affect TypeScript, Go, Rust, Python, shared API and
upgrade guidance, contract/model/scenario catalogs, replay bindings and
generated witnesses; regenerate rather than hand-edit generated output.

## Plan

1. The pull request that carries the Go source-context fix (#255) carries
   this record; it implements neither requested behavior.
2. #255 delivers the documentation: `go/README.md`, `docs/redis.md`,
   `docs/coalescing.md` and `docs/configuration.md`.
3. Coordinate edits with open #206, which rewrites the Go README, and #254,
   which changes Go remote-failure logging in `go/engine.go`.

## Deviations

None.
