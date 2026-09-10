# DialCache features and known behavioral corners

DialCache's contract covers caller outcomes, cache reuse, ownership of pending
work, and publication authority. The current inventory accounts for all 12
reviewed feature families and the known cases drawn from its documentation,
ordinary tests, models, and portable fixtures. It does not enumerate every
input or combination of features.

Quint defines the portable state transitions and their independently checked
properties. Generated histories exercise those transitions through the real
TypeScript and Go implementations. Fixed scenarios preserve narrow examples;
wire vectors and native tests cover boundaries that need different evidence.
Use [CONTRACTS.md](./CONTRACTS.md) for the obligations and
[AUTHORING.md](./AUTHORING.md) to read or extend their models.

## What is accounted for

| Inventory | Current requirement | Meaning |
| --- | ---: | --- |
| Behavioral cases | 239 | Named observable rules or specific corners |
| Wire cases | 22 | Named key, frame, envelope, timestamp and invalidation rules |
| Behavioral and wire cases | 261 | The union in [semantic-cases.json](./semantic-cases.json) |
| Native cases | 33 | Separate API, value, clock, exporter and adapter obligations |
| Positive portable scenarios | 244 | Fixed histories shared by both implementations |
| Required generated witnesses | 344 | Consequential schedules required across eight effects/feature profiles |
| Generated histories | 4,000 | Scheduled corpus across all nine conformance profiles |
| Protocol vectors | 134 | Fixed key, frame, codec, cohort and compression examples |
| Invalidation vectors | 49 | State transitions executed against real Redis/Valkey |
| Quint execution | 16 models, 117 invariants, 219 regressions | Scheduled bounded checks in [execution.json](./execution.json) |

These are current inventory and execution requirements, not a fresh passing
report. Earlier replay and mutation results remain explicitly historical in
[GO-PARITY.md](./GO-PARITY.md) and
[SEMANTIC-COVERAGE.md](./SEMANTIC-COVERAGE.md). Changed inputs require new
model, replay, integration and mutation reports with their own fingerprints.

A case can cite several scenarios, properties or witnesses, and one history
can support several cases. The 181 behavioral cases with required generated
witnesses are not 181 independent proofs. The 33 native cases are separate from
the 261 behavioral/wire cases; they are not additional generated coverage.
The feature families below overlap where one rule affects several features.

## Feature map

The machine-readable [feature-coverage.json](./feature-coverage.json) links
every family to exact case IDs, native tests, scope notes and assumptions.

| Family | Known corners accounted for |
| --- | --- |
| Public API and configuration binding | Wrapper registration versus inline loading; reserved/computed identities; static validation timing; immutable policy snapshots; omitted leaves; capacity boundaries; obsolete TypeScript options. |
| Request enablement and ownership | Outside calls skip cache plumbing and source deadlines; nested disabling and re-enabling preserve outer memo ownership; sibling scopes stay separate; closure/replacement blocks late memo publication; detached calls and policy resolution after closure follow their own admission rules. |
| Cache layers and value reuse | First-hit traversal; publication only to eligible participating layers; null, false, zero, empty text and absence in every layer; absence distinct from literal text; per-instance LRU and read promotion; zero capacity; insertion TTL without renewal; elapsed time versus wall rollback; logical freshness versus physical expiry. |
| Shared and independent callers | Same-key leaders/followers; key, operation and instance isolation; request misses joining process flights; coalescing changes during pending work; failure cleanup and error identity; independent read/source budgets; last-completion publication to request, local and remote storage. |
| Runtime policy and rollout | Whole-provider absence/null versus explicit null leaves; independently inherited sparse leaves; TTL-implied ramps; library defaults; feature kill switches; invalid invocation, layer and optional-feature leaves; exact deterministic cohort boundaries; captured admission and publication policy. |
| Read and source budgets | Library/instance/operation/runtime precedence; source budget starts at source execution; policy/read time does not spend that budget; just-before and exact deadlines; late fulfillment/rejection; abandoned work overlapping a new flight; unbounded source work; cancellation requests; accepted serialization/publication outliving a source deadline. |
| Failure isolation and adapter normalization | Key/provider/read/decode/dump/write failures; original source errors; failed-read refill suppression; observer/logger failures; explicit maintenance errors; valid frames versus metadata-only replies; unknown miss causes; valid/invalid fence metadata independent of the miss cause. |
| Tracked invalidation and publication fences | Entity grouping and untracked isolation; primary atomic snapshots; unsafe/future/version rejection before initial deserialization; strict timestamp equality; acquired fresh/local/request values; observed miss fence; both publication checks; delayed writes; retention cap/buffer/numeric limits; atomic rejection; reads/value writes preserving markers. |
| Stale recovery | Fresh limit F and exclusive maximum M; future/fenced candidates; success and classifier denial skipping recovery decode; instance/operation/default classifier precedence; own versus propagated timeout; original-error preservation; age checks before and after held decode; retained bytes across invalidation/replacement/expiry; rollback; memo publication; independent candidates and late source settlement. |
| Shadow admission, validation and fills | Hook/capacity/cohort prerequisites; served hits versus dark calls; ordinary misses and recovered results; independent dark caller sources; C0/source order; diagnostic match/mismatch/error; C1 payload and fence checks; fill authority and failures; captured logging; deduplication; per-instance capacity; held read/source/decode/dump/write work and timeout ownership. |
| Keys, codecs, compression and Redis integration | All key dimensions and argument ordering; UTF-16 cohort hashing; complete frame bytes; malformed text; safe numeric limits; raw/escaped/compressed markers; compression threshold/type/size choice; native value domains; real command dispatch and primary routing; cancellation/retry bindings; bidirectional TypeScript/Go storage. |
| Diagnostics and exporters | Error category and count with caller outcome; leader/follower trails; late rejection counted once; fallback duration excluding publication; remote duration including decode; recovery/shadow ages and future offsets; byte/compression telemetry; warning eligibility; coalescing inspection; exporter schema, privacy and registry ownership. |

## How a corner earns evidence

The catalogs now require every positive fixed scenario and every protocol or
invalidation vector to belong to a named case. This closes accounting gaps:
a fixture cannot silently sit outside the contract inventory. It does not
make every assertion in that fixture a distinct rule. Existing scenarios with
the same obligation are consolidated under the appropriate case; stable case
IDs may still have overlapping evidence.

For generated evidence, a witness must distinguish the rule's observable
consequence. Some examples of the boundaries reviewed in this expansion are:

- Recovery at F and M needs the actual returned value or original source
  error. A classifier-failure witness needs an otherwise eligible retained
  candidate; an error with no candidate cannot distinguish a broken classifier.
  An age-at-decode witness needs an age change while decoding and the resulting
  acceptance/rejection, not merely entry into a decode phase.
- C1 confirms the retained serialized payload. Equivalent UTF-8 text/binary
  representations can have identical bytes; a different serialization of the
  same decoded value is supersession. A fence witness keeps the payload bytes
  equal so a changed payload cannot independently explain rejection. A future
  C1 timestamp is distinct from rejecting a future candidate on the initial read.
- A request memo surviving invalidation must already exist before invalidation
  and remain the same owned publication. A later fill, even with an equal value,
  cannot count as survival. Last-writer cases likewise distinguish publication
  ownership and operation identity.
- Suppressing late shadow effects does not by itself prove capacity retention.
  Capacity evidence also observes a competing job being rejected while owned
  raw work remains unfinished, and the relevant subsequent release/admission.
  A reported job timeout need not cancel an independently owned dark caller.
- Diagnostics require the actual category and its associated result/count.
  An input named "source error" or a generic event label is insufficient to
  establish preservation of the original source failure.

Negative classifier controls keep the fixture or phase and remove or contradict
its public consequence. They must reject that witness. The tests in
[formal-witness-boundaries.test.ts](../test/formal-witness-boundaries.test.ts)
and [formal-witness-attribution.test.ts](../test/formal-witness-attribution.test.ts)
exercise this distinction. They test evidence attribution, so they receive no
positive behavioral-case or mutation-detection credit.

Each Quint citation also has a reviewed scope in
[quint-case-audit.json](./quint-case-audit.json). A cutoff-preservation regression
does not establish Redis TTL preservation, and a generic source-deadline
property does not establish separate budgets for two independent calls.
Definitions describe behavior; only scheduled invariants/regressions count as
checked model properties. Drivers use external inputs and actual gates;
expected state is reserved for assertions and witness classification.

## Native adaptations are explicit contracts

The 33 native cases comprise seven public API cases (B01), four host-execution
cases (B02), five value-domain cases (B03), seven observability cases (X01), and
ten resource/Redis integration cases (X02). Each applicable language names exact
tests and their scope. A non-applicable case needs a concrete explanation.

Go uses explicit contexts, typed operations, errors and goroutines. It preserves
scope and error consequences without copying Promise identity, thenables, or
Node timer handles. Native clock tests distinguish precise elapsed
source/read/shadow budgets from local TTL's whole-millisecond monotonic
observations at insertion and lookup, matching TypeScript. Integer-tick Quint
profiles cannot distinguish those fractional boundaries. API validation,
optional leaves and registration snapshots have native checks in both languages.

JSON interoperability uses Unicode scalar strings. Go rejects lone escaped
UTF-16 surrogates; a custom codec is needed for a wider string domain. Absence
has an explicit sentinel, and JSON lossiness, native comparison and borrowed
references have documented binding behavior. Callers must treat reused values
as immutable. Compression requires compatible decoding and preserved bytes/type,
not identical compressed output.

Exporter schemas and resource limits have native evidence. In particular, Go
requires accurate construction schemas when reusing external Prometheus
collectors because `client_golang` does not expose empty histogram buckets.
Current exporter schema checks are native integration checks; Quint does not
define their complete schema. Warning eligibility and backend-neutral events
have separate portable cases.

The Redis adapter must dispatch a complete frame with one `SET`, obtain tracked
snapshots atomically on the primary, and preserve cooperative cancellation.
Invalidation retries any rejected `EVALSHA` once with `EVAL` and identical
logical arguments; an invalid successful reply does not cause a retry. Actual
routing, Lua transitions and cross-language storage require real integration
checks. Historical TypeScript option diagnostics and GLIDE module identity are
explicitly non-applicable to Go's typed options and go-redis adapter.

## Remaining finite limits

Three behavioral cases have model evidence without a portable scenario,
required generated witness, or vector link. C27 local read/write failures lack
a public storage-fault injection boundary. C38 reads/value writes preserving
watermarks has a model check for cutoff preservation and native real-Redis
checks for marker existence/TTL; it has no shared portable lifetime fixture.
These are evidence boundaries, not automatically unsupported Go features.

The shadow generator does not independently exercise every possible C1 deletion
or physical-expiry schedule: its short job budget and much longer physical TTL
limit those histories. Larger request trees, operation/key/instance sets,
capacities, mixed dark/served jobs, and combined failures remain bounded.
Native malformed/truncated zstd, trailing-garbage and concatenated-stream tests
have no corresponding shared protocol vectors yet.

Finally, atomic primary reads, stable retained bytes, suitable clocks, executor
progress and watermark durability remain explicit environmental assumptions.
Race detection covers exercised schedules; sampled model checks do not prove
fairness or universal refinement. The inventory makes the known feature/corner
accounting reviewable while preserving those limits.
