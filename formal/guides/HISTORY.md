# Composition records

Measurements made when each conformance profile was rewritten over the kernel
library, at the revisions each record names. They describe the runs that were
made, not current behavior: a bound a record explains may since have been
deleted, a count may since have changed, and a corpus layout may since have
moved. The current rules are in the [kernel README](../models/kernel/README.md),
the current validation commands in [VALIDATION.md](./VALIDATION.md), and the
pilot measurements that preceded the library in issue #165. Each record keeps
the wording of the pull request that made it.

## Record of the layers rewrite

Measured on 2026-09-16 against `main` at bf3c7e8 with the manifest seed:

| | Reference | Composed |
| --- | --- | --- |
| Sampled histories agreeing step for step, both directions | | 512 of 512 |
| Exported regressions agreeing, both directions | | 15 of 15 |
| Generation wall time (512 traces, 80 steps, concurrent) | 15.7 s | 17.1 s |
| Bytes per state | 4226 | 4226 |
| Profile lines | 549 | 385 |
| Composition-lint violations (rule logic in the profile) | 73 | 0 |

## Record of the recovery-read rewrite

Measured on 2026-09-19 against the branch head that preceded the composition
(0a47889, the merge after the kernel commits 68eafb3 and ea008a7) with the
manifest seed, in one process for both generations:

| | Reference | Composed |
| --- | --- | --- |
| Sampled histories agreeing step for step, both directions | | 256 of 256 |
| Exported regressions agreeing (26 reference, 31 candidate), both directions | | 26 of 26, 31 of 31 |
| Generation wall time (256 traces, 60 steps, 1024 samples, concurrent) | 3.1 s | 4.5 s (x1.45, advisory) |
| Bytes per state | 2034 | 2304 (x1.133, bound x1.2) |
| Profile lines | 505 | 495 |
| Composition-lint violations (rule logic in the profile) | 80 | 0 |

The composed layout has the thinnest bytes headroom of the seven profiles: the
`sources` records (a landed seven-field shape every layered profile shares) and
the drivers' `markers` channel are the two largest additions, and the retired
receipt lists the largest removal. The agreed lever before any exception, should
the layered shape gain a mandatory field, is `ttls` as two integers assembled at
the `begin` call (about -40 bytes per state).

## Record of the shadow-layers rewrite

Measured on 2026-09-19 against the branch head that preceded the composition
(206e878, the kernel commit that exposed the layered release judgment, the
detached source, the scheduled deadline shape and the failure judgment) with
the manifest seed, in one process for both generations:

| | Reference | Composed |
| --- | --- | --- |
| Sampled histories agreeing step for step, both directions | | 256 of 256 |
| Exported regressions agreeing (22 reference, 23 candidate), both directions | | 22 of 22, 23 of 23 |
| Generation wall time (256 traces, 60 steps, 1024 samples, concurrent) | 6.9 s | 9.2 s (x1.33, advisory) |
| Bytes per state | 4225 | 3923 (x0.929, bound x1.2) |
| Profile lines | 646 | 465 |
| Composition-lint violations (rule logic in the profile) | 98 | 0 |

The composed layout is lighter than the text it replaces: the old text carried
a job record with the admission policy it captured, a per-slot local writer
list and the work ledger of its held fills, where the composition keeps the
kernel's `sources`, `dumps`, `writes`, `retained`, `jobs` and `deadlines`
records and reads the admission facts in the connection model's pre-state. Its
one new regression, `localEntryExpiresAtItsInsertionTtlTest`, pins the strict
local expiry the old text stated implicitly, so shadow-layers joins the
`policy-inclusive-local-expiry` partition: the entry a settled source inserts
is a hit at once and a miss exactly one local TTL later (the drivers' 60 s
advance).

The review round that followed corrected two `shadow` rules no scheduled
profile reaches, stated as the ports have them: a dark fill judges its
captured fence before serializing (`fill_fenced` at settlement, no dump), and
a failed job read ends the job (`redis_error` at the dark C0 read,
`confirmation_error` at the confirmation read); it also guarded the dark arm
against the bypass reply, moved the `JOB` kind into `deadlines`, folded the
recovery miss into `recovery::failure`, deleted the unused `remote_writes`
entry points and added two regressions pinning `match` and `superseded`. The
differential against 16bb2c6 agreed on 279 of 279 reference and 281 of 281
candidate histories (23 and 25 regressions) at 3923 bytes per state both ways
(x1.000); the seven other composed profiles were unchanged.

Later rewrites are recorded as one row each, measured against the branch head
that preceded them with the manifest seed, in one process for both generations
(sampled histories and exported regressions agreeing step for step in both
directions; bytes per state against the bound in force). recovery declares
`differential.maxBytesPerStateRatio: 1.85`: the text it replaces was the
thinnest profile in the repository (1544 bytes per state: the two channels and
twenty-five scalars), and the composition pays the held shape's per-flight
`LayeredSource`, the per-caller registries and the `io` channel (about 2015
bytes of library records against 790 of retired scalars), so the floor of any
composition over the landed held shape is about x1.7; in absolute terms 2769
sits between recovery-read (2304) and independent (2845), and the corpus is
about 85 MB. The declaration is transitional, for the rewrite's own
differential against the retired text: the first PR after this one merges
deletes it, and the composed text is then the reference at x1.0 under the
default bound. local-failure declares
`differential.maxBytesPerStateRatio: 1.45`: a ten-call profile over the layered
shape pays that shape's fixed remote fields (about 233 bytes per state) and
flight registries (about 216) on a 1056-byte base, its profile-owned bytes are
43, and no trim inside the landed shapes reaches x1.2 (5.5 MB to 7.8 MB in
absolute terms). Re-measuring every shared-library partition over the two
profiles moved local-clock into `policy-inclusive-local-expiry` and
`source-budgets-settlement-never-replaces-local-entry` (its
`callsServeLiveEntriesOrRunTheSource` rejects both mutants) and restated the
other cells' reasons for the composed texts. admission declares
`differential.maxBytesPerStateRatio: 1.65`: the text it replaces kept a
five-field `Call` per caller and jobs that carried their own identity (3024
bytes per state), and the composition pays the held shape's seven-field
`LayeredSource` per caller flight and per detached job source (about 886 bytes
per state over the old `calls`), the `io` channel (329) and the per-caller
`memoSlots` (160); no trim inside the landed shapes reaches x1.2 (the gap is
about 1281 bytes per state against about 280 available), so the bound is
transitional like recovery's and is deleted by the first PR after this one
merges. The margin over the measured x1.624 is 1.6 %; generation is
deterministic under the manifest seed and backend. Re-measuring every
shared-library partition over the composed text moved admission into
`recovery-strands-followers`, `source-budgets-accepts-at-deadline-equality`
and `policy-join-ignores-coalesce`, and its two profile faults became
shared-library faults on `shadow.qnt` (`busy`, `full`) partitioned over all
fifteen profiles, the duplicate one gaining an exported-regression reproducer.
shadow declares `differential.maxBytesPerStateRatio: 1.8`: the text it
replaces kept one scalar set for the current caller (1816 bytes per state),
and the composition pays the held shape's seven-field `LayeredSource`,
registries and `io` rows for every caller a history made (5.09 per state on
average, about 1390 bytes per state of per-caller records) plus the held read
and decode records the job's effects now occupy in `remote_io`'s lists; no
trim inside the landed shapes reaches x1.2 (the pending-only registry is
already taken, and budgeted variants of the atomic lifecycle would reach only
about x1.6 with a second variant set that states no rule), so the bound is
transitional like recovery's and admission's and is deleted by the first PR
after this one merges. The margin over the measured x1.791 is 0.5 %;
generation is deterministic under the manifest seed and backend. Re-measuring
every shared-library partition over the composed text moved shadow into
`policy-inclusive-remote-freshness`, `source-budgets-accepts-at-deadline-equality`,
`shadow-layers-inclusive-c0-freshness` and
`shadow-layers-fill-uses-current-retention`, and the retired standalone
shadow validation model's two challenges re-anchored on
`remote_writes::dispatch` and `shadow::settleJobRead` with exported-regression
reproducers; the two private-reading witness classifiers became one
public-only classifier bound through the fidelity scaffold. effects declares
`differential.maxBytesPerStateRatio: 1.45`: the text it replaces kept one
integer per private fact (3586 bytes per state, 2262 of them the drivers'
`events` trail, unchanged in shape by the composition), and the composition
pays the held shape's seven-field `LayeredSource` per flight (about 590 bytes
per state), the per-caller registries (231), the `io` and `d` channels
(331) and the deadlines, held records and metric instants (about 360); with
every profile-owned and metrics field removed the floor over the landed held
shape is about x1.24, so x1.2 is out of reach and the two trims that fit (one
`sourceStarted` list in place of a per-source history, the observer fault
left to the input) were taken. In absolute terms 5108 sits between layers
(4226) and admission (4910). The bound is transitional like recovery's,
admission's and shadow's and is deleted by the first PR after this one merges,
together with the retired-layout branch of `formal/replay/effects.mjs`
(`retiredFields`, `retiredExpected`), which reads the reference corpus
while the merge base with main still carries the retired text. Re-measuring
every shared-library partition over the composed text moved effects into
`recovery-read-wrong-admission-policy`, `independent-wrong-admission-policy`,
`recovery-strands-followers`, `stale-recovery-future-candidate`,
`source-budgets-accepts-at-deadline-equality` and `shadow-fenced-fill-writes`;
its three profile faults became shared-library faults on `serving.qnt`
(`refills`), `deadlines.qnt` (`arrival`, which shadow also detects) and
`metrics.qnt`, partitioned over all fifteen profiles with exported-regression
reproducers; and the standalone flight-deadlines model and the effects
connection model were retired, every rule they stated being a kernel rule a
composed profile exercises. The composition also re-recorded 74 of the 93
effects label counts in `witness-baseline.json`: at the pinned seed 0xd1a1ca
the composed actions consume the random stream differently (pending-only held
records, the favored-branch guard reading `Writes::latestDump`) and so sample
a different corpus, the `reply:15` recorded-seed gate tripped (11 to 4) and the
baseline was re-recorded, the both-way differential (554 of 554 forward, 560 of
560 reverse) being the evidence that the two texts are equivalent.

| Rewrite | Measured | Histories agreeing | Generation wall (advisory) | Bytes per state | Profile lines | Lint violations |
| --- | --- | --- | --- | --- | --- | --- |
| recovery | 2026-09-20 against 2add082 (the read settled in its step, the held release split from its judgment, the diagnosed held lifecycle) | 512 of 512 and 30 of 30 | 11.6 s -> 21.0 s (x1.80) | 1544 -> 2769 (x1.793, bound x1.85, model) | 466 -> 443 | 80 -> 0 |
| local-failure | 2026-09-20 against 75d709e (the fractional clock, the inline local call, the newest source and the policy-provider layout fact) | 128 of 128 and 5 of 5 | 0.8 s -> 1.7 s (x1.95) | 1056 -> 1477 (x1.399, bound x1.45, model) | 169 -> 215 | 24 -> 0 |
| local-clock | 2026-09-20 against 75d709e (the same head) | 128 of 128 and 4 of 4 | 1.6 s -> 2.2 s (x1.34) | 2904 -> 1819 (x0.626) | 139 -> 168 | 11 -> 0 |
| admission | 2026-09-20 against 56bb2bb (the lint denylist, the case audit folded into semantic-cases, the shared fidelity scaffold, the derived go-parity sections) | 128 of 128 and 6 of 6 / 8 of 8 | 2.8 s -> 6.1 s (x2.17) | 3024 -> 4910 (x1.624, bound x1.65, model) | 455 -> 368 | 65 -> 0 |
| shadow | 2026-09-20 against 943f139 (the held shadow lifecycle, the payload forms, the buffered invalidation, the pending-only registry) | 1024 of 1024 and 7 of 7 / 39 of 39 | 8.1 s -> 17.0 s (x2.10) | 1816 -> 3251 (x1.791, bound x1.8, model) | 696 -> 637 | 96 -> 0 |
| effects | 2026-09-20 against cf03e05 (the shadow composition merged under the effects kernel commit: the read settlement split from its judgment, the held refill over the held read path) | 512 of 512 and 42 of 42 / 48 of 48 | 11.2 s -> 17.7 s (x1.58) | 3586 -> 5108 (x1.425, bound x1.45, model) | 680 -> 593 | 64 -> 0 |

The pilot that preceded the library (#171, #172) instantiated one kernel state
machine per profile and measured its cost; its conclusions and measurements are
recorded in issue #165.

## Record of the dark-layers interaction profile

This new profile has no reference corpus to compare. With the manifest seed,
256 sampled histories contain 15,616 states and 69,478,386 bytes (4449 bytes per
state); 18 named histories pin the public interaction boundaries. Its twelve
kernel transitions introduce no profile rule-logic violations. The additional
transient-request diagnostic history records a model correction found by replay:
TypeScript and Go both attribute an active-local failure to local, and a
request-only failure to request_local even without a persistent memo slot.

The sampled corpus contains nine match verdicts, eight mismatches, one
supersession and no confirmation errors, and 79 request-local follower joins.
The separate shadow profile retains named confirmation-error coverage.


## Separate shadow read deadlines

`shadow-reads.qnt` composes the held dark lifecycle with each read's bounded
result and raw completion. A 5 ms read may end validation before its 10 ms
job deadline; a 20 ms read can outlive that deadline. Bounded errors cancel
the read and forget the job timer while the raw adapter operation keeps its
registration. Late raw completion only releases capacity. The caller source
keeps its independent result. C1 captures the job's admitted read policy,
then measures its read deadline from C1 dispatch.

`shadow-read-deadlines` schedules six public histories, with required witnesses
for cancellation, contexts, verdicts, competing-key rejection and readmission.
Independent properties require every held raw read to retain its registration,
every cancelled read to have ended its bounded result, and ended reads to have
no remaining job timer. M61 and M62 distinguish losing bounded completion from
releasing raw ownership early, in the model and both native implementations.
Existing profiles retain their simpler projection when their bounds cannot
reach a separate shadow read deadline; factoring `retireJob` preserves it.

## Historical validation results

The merged baseline's detailed run logs remain in
[the versioned record from PR #161](https://github.com/lan17/DialCache/blob/fa4ef77489fd124213b5877479f69e2086c1aa90/formal/guides/VALIDATION.md).
Current results belong in PR summaries and uploaded artifacts.
[VALIDATION.md](./VALIDATION.md) explains how to produce and interpret
evidence; it is not an accumulating log of previous executions or
machine-specific temporary paths.
