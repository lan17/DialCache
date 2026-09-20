# Kernel library

The kernel library states every portable DialCache rule once, as pure
transitions over the part of the state each rule touches. A conformance profile
composes these transitions over its own bounded state: it declares the state its
fixtures exercise, owns the choice of inputs and the environment restrictions,
and assigns state only through library transitions. Issue #165 records the
design and its history; this file describes what is here and how to use it.

## Modules

| Module | Concern | Transitions and judgments |
| --- | --- | --- |
| `encodings` | Sentinels shared by the modules: 0 for an absent value, -1 for an unowned slot, 0 for no fence; the `accepted` judgment over outcome codes | `accepted` |
| `calls` | What a caller asks for: instance, key, request context, whether it is enabled (a disabled context, a failed key or a call outside every request is not) and whether its key failed to construct, the one bypass whose source keeps the configured deadline (C27) | the `Call` type only |
| `instances` | Which instances the environment has constructed (`Constructed`): the local-clock drivers construct default instances at fractional process times and the model records only that an instance exists, since the layers judge time on the shared whole-millisecond grid whatever the construction phase (C09); read by guards and input domains alone, never by a rule, and kept as a transition because the composition lint has no environment allowance yet, as `request_memo::openScope` is | `construct` |
| `layer_policy` | Which layers a call may use, from the drivers' layer policy code and remote availability; the immediate reply `resolution` and the `BYPASS` reply; the `Ttls` a reply resolves to (local insertion TTL, remote freshness, remote retention), passed beside the resolution, and the `gated` layers a reply uses with them (a layer whose TTL is 0 is off); the `effectiveTtls` of the layers a reply uses (a layer left off has TTL 0), which a traversal suspended at the remote layer carries instead of the resolution | `enabledLayers`, `sharedLayers`, `resolution`, `gated`, `effectiveTtls` |
| `runtime_policy` | How a runtime policy reply (the runtime-boundaries drivers' codes 0 to 21) resolves against an instance's configured baseline: serving cohorts, omitted, null and invalid leaves, runtime TTLs, the kill switch | `resolve` |
| `request_memo` | Request-scoped memo rows and their closure; `openScope` and `Opened` are environment bookkeeping (which contexts an input has created) that no memo rule reads, kept beside the memo rows because the composition lint has no environment allowance yet | `scopeOpen`, `memoSlot`, `memoValue`, `memoize`, `openScope`, `closeScope` |
| `local_storage` | Per-instance local storage with LRU eviction, insertion expiry (`cache_rules.localEntryLiveAt`) and a hit that renews recency, not insertion | `localValue`, `promote`, `putLocal` |
| `payloads` | Payload validity classes: the code a remote frame stores. The drivers' value codes below 100 decode to themselves; an enveloped band from 100 up keeps class and value apart, a class hundred (`COMPRESSED`, `CORRUPT`, `UNSUPPORTED_ENCODING`, and the two spellings that decode like a plain value but carry other bytes, `PADDED` and `UNICODE`, the shadow drivers' payloads) plus the value the bytes carry (`classOf`, `valueOf`; a profile spells a seed as `Payloads::COMPRESSED + VALUE_ONE`, arithmetic over constants; the form line `BINARY`: a payload at or above it is the binary spelling of the text payload below it, the same bytes, `bytesOf`, which every class judgment reads and the shadow confirmation compares across the two forms, C51; a compressed or corrupt code reaches a decode step or candidacy only with a positive value, the test `remote_frames::observe` and `recovery::retain` apply before any decode, so a bare class code is routed as a declined visible frame, and `UNSUPPORTED_ENCODING` is spelled bare because it names no value), and says what a frame's bytes do by their class alone, judged once in `remote_frames::observe` for the atomic release and the held read settlement, at the held decode (`remote_io::settleLoad`) and at candidate retention (`recovery::retain`). A code that fails the read never reaches a serve site; one that fails the decode reaches it only through the held decode step, which fails it; every serve site judges the decoded value, never the code (`serving::decide` and `remote_io::settleRead` serve a positive `valueOf` only, `recovery::retain` admits a candidate only when its code decodes to a value), so a code whose `valueOf` is `NO_VALUE`, the integer `CALL_PENDING` shares, never completes a caller. Documented limit: the atomic release has no decode step and serves `valueOf` of a fresh corrupt frame, the value its bytes would have carried, so a profile over the atomic path seeds no decode-fault payload (pinned by the payload-classes fixture) | `bytesOf`, `classOf`, `valueOf`, `readFails`, `decodeFails`, `decodeOutcome` |
| `remote_frames` | Remote frames stamped on the wall clock and retained until an instant on the monotonic clock (`cache_rules.deadlinePendingAt`), `visible` while present, retained and (tracked) fence-cleared whatever their age, served while also fresh for the reply's freshness (`cache_rules.freshAgeAllowed`, which rejects a stamp from after a wall rollback); per-entity watermarks and fences on the wall clock (`cache_rules.fenceAllows`); an invalidation never lowers a watermark: it raises it to the wall clock plus the invalidator's future buffer only when that is ahead (`raiseWatermark`, the public `futureBufferMs`; 0 where the drivers pass none), and only a marker's expiry (`markers`) lowers one, to the zero baseline (`clearWatermark`); what one read observes, judged once for the atomic release and the held read settlement (`observe`: whether the read `failed`, the drivers' fault or a visible frame whose payload code fails the read, `payloads::readFails`; a failed read observes nothing; else whether a frame is visible, its `payload` code and the value a fresh one serves, what the code decodes to, `payloads::valueOf`); the tracked one-hour cap on the retention a refill is written with (`TRACKED_RETENTION_CAP_MS`, `physicalRetention`: an untracked write keeps its full retention, and the recovery snapshot's logical maximum is never capped); a refill's fence is the watermark a read observed when it found no visible frame (`fenceFor`, C58: a visible frame the traversal declined carries none; on the atomic path this rule is pinned by the frame-clocks fixture runs `visibleStaleMissCarriesNoFenceTest` and `frameAtTheWatermarkKeepsTheMissFenceTest` and by the TypeScript reading, where `src/internal/redis-cache.ts` returns the observed watermark only for an adapter-side miss and `src/dialcache.ts` forwards it to the refill only for a miss status, not by the composed differentials: the one composed corpus that declines a visible frame, policy, is untracked, where the old and new rules both yield no fence, and the tracked corpus, layers, retains frames exactly as long as they are fresh, so it never declines one); a write with an explicit stamp (`storeFrame`), with the wall clock (`seedFrame`) or at an age (`seedAged`) | `storeFrame`, `seedFrame`, `seedAged`, `raiseWatermark`, `clearWatermark`, `visible`, `fenceCleared`, `observe`, `missFence`, `fenceFor`, `writeAllowed`, `retained`, `fresh`, `physicalRetention` |
| `flights` | Source executions (a record of outcome and process sharing, with whatever payload the traversal that started it needs), the process and request registries that coalesce callers, and per caller its owner and memo slot; settling a source is recording its outcome (`recordResult`) and forgetting it in the registries (`forgetSource`), apart so a flight that first recovers a retained value stays joinable until it completes; a detached source (`registerDetached`, a served shadow job's: appended under the next index and registered nowhere, so `ownedBy` is empty for it); the newest source (`latest`, for a profile whose drivers settle the latest loader rather than one named by index, and for an inline source settled by the call that started it); an opt-in record of the identity each caller asked for | `processOwner`, `requestOwner`, `admitCaller`, `attachCaller`, `joinRequestFlight`, `registerSource`, `registerDetached`, `recordResult`, `forgetSource`, `forgetScope`, `ownedBy`, `latest`, `recordIdentity` |
| `clock` | Elapsed time on the monotonic clock; the wall clock is that clock plus a skew (`wallOf`), so one transition moves both and only the skew shifts on a rollback; the environment's fractional time beside the clock the layers read (`Ticked`: the drivers' ticks, with the monotonic clock as that time on the whole-millisecond grid, `cache_rules.wholeMs`, so a fractional advance moves `now` only across a millisecond boundary and local insertion and expiry fall on the grid whatever an instance's construction phase, C09) | `advance`, `advanceTicks`, `wallOf`, `shiftWall` |
| `policy_gate` | Callers whose policy reply the environment holds, with their calls, indexed by their policy call | `hold`, `holding`, `holds`, `latest`, `entry`, `release` |
| `serving` | Admission, traversal order (`decide`), ownership precedence, publication and refill authority with the TTLs each source captured from the reply that started it, the remote adapter's read, dump and write faults along a refill, scope closure, maintenance (`invalidate`, the outcome rule of the write-fault switch: `missing_remote` without remote storage, `mutation_error` under a write fault with the invalidation counted and the watermark unmoved, `ok` raising the watermark to the wall clock plus the invalidator's future buffer, `bufferMs`, 0 where the drivers pass none; `maintains`, whether an invalidation takes effect, the judgment the effective arm branches on and a marker lifetime reads); the layered shape and its local and request-only projections; the layered release judged once (`judgeRelease`, with the remote observation as a parameter; `layeredRelease` observes it; the judgment carries the observation, `remote_frames::Observed`, which `startSource` passes to the authority so a failed read, an adapter fault or a payload that fails the read alike, denies the refill on the atomic path as on the held one, and a source started without the remote layer passes `remote_frames::UNOBSERVED`; `judgeReleaseUnder` takes the local read's fault as an argument, `local_faults`: the local value hidden, the layers and the sharing as the reply resolved them, and the judgment carries the fault so `releaseJudged` publishes for the TTLs it allows, `publishable`: no local TTL for the remote hit it serves or the source it starts) for the transition and the records composed around it, and the steps a held remote effect suspends between, which the atomic path composes too: the release prologue up to the remote layer (`applyRelease`), publication authority fixed when a remote read completes (`authority`, capturing the retention the refill is written with, `remote_frames::physicalRetention`, so the source record and the write agree), warm-on-hit (`warm`), completion apart from the recorded outcome (`complete`, `finish`) and publication apart from completion (`refillAllowed`, whether a captured authority may be written now, the judgment a caller's refill, `refills`, and a shadow job's fill, `shadow::fill`, share; `dispatchWrite`, `publish`, `settle`); the judgment applied apart from the judging (`releaseJudged`, the release after `layeredRelease`, so a variant that records beside the release judges once and applies the same judgment) and a detached source (`startDetachedSource`: a source no caller owns, counted against the profile, probed as not participating, without publication authority, whose settlement completes no caller); whether the drivers install a policy provider is a layout fact (`Layout.policyProvider`: `entered` counts a policy call per participating admission only where one exists; an instance that resolves policy from its key's default configuration, the local-clock drivers' default instances, makes none); the local projection's immediate reply (`beginLocal`) and its inline call (`callLocal`: the loader returns before the call does, so the source a miss starts settles at once with the loader's value and a hit settles nothing) | `admit`, `release`, `judgeReleaseUnder`, `releaseJudged`, `startDetachedSource`, `begin`, `settle`, `publish`, `complete`, `finish`, `admitLocal`, `releaseLocal`, `settleLocal`, `beginLocal`, `callLocal`, `admitRequest`, `releaseRequest`, `settleRequest`, `closeScope`, `invalidate`, `maintains`, `refillAllowed` |
| `local_faults` | The local storage fault switch (C27) over the layered shape (`Faulted`: `serving::Served` with `localFailed`), read at the two points a call touches local storage and passed as an argument, the kernel's fault idiom, never turned into a TTL the layer gating reads: an admission with an immediate reply (`begin`) judges the layered release with the fault as its argument (`serving::judgeReleaseUnder`: the local value hidden, the layers and with them the coalescing untouched, nothing warmed from the release) and applies that judgment (`serving::releaseJudged`), so the traversal reads nothing from local storage, a remote hit warms nothing, the source it starts captures no local TTL (publication-ineligible whatever the switch says at settlement) and two callers under the fault share one source as two healthy callers do, as the implementations decide the process flight from the resolved layer configuration before the read and a read that throws disables only that call's local value and write (`src/dialcache.ts` `getThroughSharedLayers`, `getThroughActiveLocal`); a settlement (`settle`) withdraws the source's captured local TTL, so `serving::publish` warms nothing while the callers complete with the accepted result, the request memo is written and the remote refill proceeds; the traversal and the publication keep their one statement in `serving`, and the remote fault switches stay in `serving::Served` because the traversal reads them mid-release where this one is read at its two entry points; one consumer today, local-failure | `begin`, `settle` |
| `markers` | Invalidation markers: the lifetime of an entity's watermark, which the implementations keep as a Redis key with a TTL (`src/internal/redis-scripts.ts`): the larger of the two-hour floor (`MARKER_FLOOR_MS`, twice the tracked cap) and the span from the invalidation's wall clock to the watermark plus the cap and a minute's margin (`lifetime`), keeping a longer remaining lifetime; marker expiry is a time transition that returns the watermark to its zero baseline (`expire`, run by `advance`, through `remote_frames::clearWatermark`), so `remote_frames` keeps reading the raw watermark and the fence stays stated once, and only an expiry lowers a watermark; an invalidation stamps a marker when it takes effect (`serving::maintains`), as a variant of `serving::invalidate` passing the invalidator's future buffer through, whose outcome rule it does not restate (the marker lifetime reads the raised watermark, so a buffer lengthens the marker as the script does); `observe` appends the marker the drivers read (its cutoff against an explicit origin and its remaining lifetime) or `NO_MARKER` (PTTL -2 on a missing key); one consumer today, recovery-read | `invalidate`, `advance`, `expire`, `observe`, `inForce`, `lifetime` |
| `deadlines` | Deadlines: one pending-only list of `Due` records (the work's kind, `READ`, `SOURCE` or a shadow job's `JOB`, its index in the drivers' order and the instant it is due), registered when bounded work starts and forgotten when it settles or is delivered, so bounded is presence; the budget a source starts with (a source started at admission is bounded only when its key failed, C27, a disabled context and an outside call run theirs unbounded, C01; a source started at release, with or without the remote layer, or a loader started for a held read is bounded, its caller was enabled when admitted; a held read is bounded by the read budget in force at dispatch); the `Scheduled` shape, the clock beside the pending deadlines, which registration (`due`), forgetting (`forget`) and delivery read and which `Budgeted` extends with the source budget and the drained flags: a module that bounds work of its own kind composes `Scheduled` alone (`shadow`'s jobs, kind `JOB`); instant-ordered delivery (`deliver`: an advance moves both clocks to each due instant inside it and delivers what is due there in registration order, so a loader a read expiry starts is delivered at its own instant in the same advance; a deadline the clock passed undelivered is delivered at the first instant the next advance visits); a result arriving after its deadline is a deadline error (`arrival`); abandoned work drains once, when its result arrives; as budgeted variants of the local lifecycle, which keep per-source history (`started`, `budgets`, `settledAt`), and of the held lifecycle (admission and release apart for a profile whose drivers hold policy replies, `begin` for immediate ones, `beginRead` for immediate ones whose drivers hold decodes and loaders but not reads: the read the step dispatched settles in it, `settleDispatched`, registering no read deadline under the unbounded budget such a read takes, a finite one reached at once only when zero; `releaseJudged` applies a release judgment already made, `release` is its composition with the judgment, so a variant that records beside the release judges once) | `admitLocal`, `releaseLocal`, `settleLocal`, `advanceLocal`, `admit`, `releaseJudged`, `release`, `begin`, `settleDispatched`, `beginRead`, `settleRead`, `settleLoad`, `settleLoader`, `advance` |
| `remote_io` | Remote effects the drivers hold and release by effect index, over the layered shape (`Held`): the release judged with the remote layer unobserved dispatches the read (counted then, its budget on the drivers' `io` channel) and registers the caller's flight, so a follower released while the read is pending joins it, or starts a source without the remote layer at once; every source started as a new flight takes the drivers' next loader ordinal (`mapLoader`, stated once for admission and release; a loader started for a held read's flight maps itself); the read settles with the state then current (a payload that fails the read fails it like an adapter fault), holding a decode with the frame's payload code or starting the flight's loader with the authority the read fixed; a decode settles by completing the flight with the value its payload decodes to (a fresh one warming local storage) or restarting a loader after a failed decode (the drivers' fault or a payload whose bytes fail to decode, `payloads::decodeFails`, which a recovery decode reports as its deserialization error); a loader settles by the drivers' ordinal (`loaders` maps ordinals to flights) and, failed, consults the flight's recovery snapshot through `recovery::failure`, holding a recovery decode when the candidate serves and completing with the error otherwise (the miss reported by `recovery::failure`); a read whose deadline was delivered owns nothing and its late reply drains; `io` (read budgets, aborted reads, per-caller source-error identities) is written by the transitions that have each fact in hand. Held reads and decodes are pending-only records; `releaseJudged` is the release applied from a judgment already made (`serving::judgeRelease` with the remote layer unobserved) and `release` its composition with the judgment; `begin` is admission and the held release in one step for a profile whose replies are immediate (a read settled in its dispatching step is `deadlines::settleDispatched`, the budgeted variant's: only that shape can forget the read deadline it may have registered); `latestRead`, `latestLoad` and `latestOrdinal` name the most recently held read and decode and the newest loader ordinal for a profile whose drivers name the latest effect rather than an index; `holdRead` is a read held over a flight (counted, budgeted on the io channel, indexed), stated once for the caller's dispatch here and a job's confirmation read in `shadow` | `admit`, `releaseJudged`, `release`, `begin`, `holdRead`, `settleRead`, `expireRead`, `settleLoad`, `settleLoader`, `latestRead`, `latestLoad`, `latestOrdinal` |
| `compression` | The compression channel: the outcome a decode reports as it is dispatched (`payloads::decodeOutcome`: "decompressed", "fallback_raw", nothing for an uncompressed frame), appended by variants of the two held transitions that hold a decode (`remote_io::settleRead` on a fresh frame, `remote_io::settleLoader` on a failed loader with a recovery candidate) over `Compressed`, the held shape with a `compression` channel; a variant rather than a mandatory `Held` field (independent would carry a channel it never reads) or a profile-side wrapper (invisible to the composition lint); one consumer today, recovery-read | `settleRead`, `settleLoader` |
| `recovery` | Stale-on-error recovery (C40 to C46, C57) as a consulted record: the snapshot a flight retains when its read completes without serving (the visible frame's payload code when it decodes to a value, `payloads::valueOf`, and its age lies in [freshness, maximum), its stamp at the read, the maximum the reply's retention resolved to, the classifier in force), the loader failure judged once for whichever path consults it (`failure`: the classification counted, whether the candidate then serves, and the miss reported when recovery was allowed and it does not) and the recheck at recovery-decode settlement (`recovered`: the label and whether the candidate serves; a flight that does not serve it completes with the outcome its source recorded); classifier codes `NONE` (no stale-on-error: nothing is retained), `TIMEOUT_ONLY`, `ALLOW`, `DENY` (a profile decodes a classifier that throws to `DENY`, as the implementations do); `remote_io` and `remote_writes` read it (the held path holding a recovery decode, the atomic one decoding at once), no profile composes a recovery transition | `retain`, `failure`, `classified`, `mayRecover`, `validCandidate`, `recovered`, `recordOutcome`, `drop` |
| `remote_writes` | The atomic remote lifecycle with held writes, over the layered shape (`Writing`: held dumps and writes as pending-only records keyed by the drivers' effect ordinal, and the recovery snapshots): the layered release applied from its judgment (`releaseJudged`, the one release seam: `shadow` judges the release once through `serving::layeredRelease` and applies it here), retaining the snapshot of a source it starts after a completed remote read that served nothing (`recovery::retain`, as the held read settlement does); a source that settles accepted and refills records its result and holds its dump (`settle`, `holdDump`: the dump counted then, with the retention the source captured and the fence its read observed, C18/C58) and publication completes with the write: the dump released dispatches the write stamped with the wall clock of that release (`dispatch`, `serving::dispatchWrite`, C33; a fence the wall no longer clears stops it and the flight completes without one), the write released stores the frame with the captured stamp, warms local storage for the source's local TTL and completes every owner (`store`, `releaseWrite`); an accepted value that does not refill publishes and completes at once (`serving::publish`); a failed source consults the flight's snapshot once (`recovery::failure`) and, the path being atomic, decodes the candidate at once (`failed`: the decode counted, `recovery::recovered`) or completes with its error (the miss reported by `recovery::failure`); the adapter's dump and write faults are the `failed` argument of the two releases (a failed dump dispatches no write, a failed write stores nothing, the flight completes either way, as `serving::publish` has it); a dump abandoned before its release dispatches no write (`abandonDump`); the newest held dump and write (`latestDump`, `latestWrite`, as `remote_io` names its latest read and decode) for a profile whose drivers release the latest effect; one consumer today, shadow-layers | `releaseJudged`, `settle`, `failed`, `holdDump`, `dispatch`, `abandonDump`, `abandonWrite`, `releaseDump`, `store`, `releaseWrite`, `complete`, `finish`, `holdsDump`, `heldDump`, `holdsWrite`, `heldWrite`, `latestDump`, `latestWrite` |
| `shadow` | Shadow jobs (C47 to C54, C57, C60): the diagnostic work a served remote hit or a ramped-down miss admits beside the caller, in one per-instance registry of bounded capacity shared by both kinds (`Jobs`: the jobs, their budgets and the sources they run for; pending-only and keyed by the job's source, a finished job leaving no record, as a settled held read or dump does), composed by two lifecycles: the atomic one (`Shadowed`, `remote_writes::Writing` with the jobs and their deadlines) judges the hit and the policy in one step at release and makes the dark C0 read, the decode and the confirmation read at once; the held one (`HeldJobs`, `remote_io::Held` with the held fills, the jobs and their deadlines) holds them as `remote_io` holds a caller's read and decode, in the same lists under the drivers' effect indices, budgeted on the io channel like every held read and never deadline-registered, a held effect over a source whose job is reading or decoding being that job's (`holdsRead`, `holdsLoad`, `latestRead`, `latestLoad`). The policy in force for a call is `Shadowing`: whether the outcome hook is installed (C47), the cohort selection its reply resolved (per call, C18), the instance's capacity and job budget, and whether a confirmed mismatch is logged (C60, captured by the job, `Job.logging`); `Malformed` says whether the ramp or the logging value failed to resolve; the comparator the drivers install is `Comparison` (ordinary value equality, or a callback reporting equal, unequal, or throwing after consuming elapsed time). A job captures the TTLs its reply resolved to (`Job.ttls`, C18) and the fence its C0 read observed when it found no visible frame (C58); the fill authority is `serving::authority` at the fill (`fill`, one statement for callers and jobs through `serving::refillAllowed`: the retention capped for a tracked write, `fill_fenced` before serializing when the fence no longer allows the write, no dump). Atomic admission beside the release judged once (`admitJobs` from `serving::layeredRelease`; `release` and `begin` compose it after `remote_writes::releaseJudged`): nothing unless the hook is installed and the reply selected the cohort (`admits`); a served job over a detached source (`admitServed`, stated once for both lifecycles: `serving::startDetachedSource` with the payload the hit served as its C0), a dark job over the caller's own source reading its C0 from the remote layer itself (the read counted; the payload when the frame is fresh for the reply's freshness, `acquired`, nothing otherwise), a dark C0 read that fails being the label alone, `redis_error`, the read counted, no job, nothing filled; nothing for an ordinary serving miss, a request or local hit or a bypass reply (the caller's scope closed before its release), `dropped` for a live job of the same identity or a full instance (`busy`, C47); settlement of the job's source (`settle` after `remote_writes::settle`, `settleJob`: `sourceOutcome`, `source_error`, or `timeout` for a source the caller's deadline failed; the fill when there is no C0; else the decode counted and `match` when the decoded value agrees, `valuesMatch`, or a confirmation read counted and its verdict, `confirmation`, the one judgment for both lifecycles: `mismatch` when the C0 bytes are still current, `payloads::bytesOf`, so a text and a binary spelling confirm each other, `superseded` otherwise, `confirmation_error` when that read fails); the held fill's releases (`releaseDump`, `releaseWrite`: `filled`, `fill_fenced`, `fill_error`; a dump released after the budget dispatches no write while a write released after it still stores, C53; a job's fill completes nobody). The held lifecycle's rules, stated once over `remote_io`: the source settled fills or holds the decode (`settleJobHeld`), the decode settled says `match` or holds the confirmation read under the read budget in force (`settleJobLoad`: `deserialization_error` when the decode fails; the comparator's elapsed time moving the clock without delivering timers, a budget it reaches ending `timeout` before any verdict, a throwing callback `comparison_error`, the callback counted, `o.comparisons`), the read settled says the verdict or acquires the C0 with its fence and continues at once when the source already settled (`settleJobRead`; `redis_error` for a failed C0 read); a timed-out job ends silently at whichever step finds it so, keeping its slot until then. Served jobs (`HeldShadowed`, the admission profile: `beginHeld` and `releaseHeld` over `remote_io::begin` and `release`): the selection is captured for the flight whose read the step dispatched (`capture`, a pending-only list of flights) and consulted when the hit is judged, at the decode's settlement (`settleLoad`: a fresh frame decoded completes the flight with a served hit, which admits the job through `admitServed` under the hook and limits read then and maps its detached source to the drivers' next loader ordinal; a failed or recovery decode admits nothing), or forgotten at the read's settlement when it holds no decode (`settleRead`); a job's read or decode settles as the held lifecycle has it, a loader by the drivers' ordinal (`settleLoader`). Dark jobs (`DiagnosedShadowed`, over `diagnostics::DiagnosedHeld`: the caller's source deadline, the layer its failure is attributed to and the channel the shadow drivers compare): `beginDark` is the diagnosed held release (`diagnostics::admit`, `serving::judgeRelease`, `diagnostics::releaseJudged`) with the configuration error a malformed policy reports (`diagnostics::recordConfigError`: an invalid ramp always, an invalid logging value only where the hook and the ramp would otherwise admit the job), the job registered with its budget (`admitDark`) before the source's synchronous work moves the clock, and the C0 read dispatched or the job timed out with no read when the work exhausted the budget (`dispatchC0`, C54); `settleHeld` settles a loader through `diagnostics::settleLoader` and continues the job waiting on a flight the step settled; `releaseRead` and `releaseLoad` are the job's read and decode settlements with the channel facts recorded beside the label they reported (`recordVerdict`: a `match` or a confirmed `mismatch` samples the C0 frame's age at the verdict, clamped to zero after a wall rollback, `diagnostics::recordAge`, C57, and a confirmed mismatch warns exactly when the job captured logging on, `diagnostics::recordWarning`, C60; a shadow read of a frame stamped after the wall clock reports the offset on the `remote_shadow` layer whatever follows, `diagnostics::recordFutureOffset`); `advanceHeld` delivers job budgets, read deadlines and source deadlines by kind (`expireHeld`: a source deadline ends the job waiting on its flight `timeout` through `settleJobHeld`, releasing its slot, and a job budget due in the same round finds it gone). Every job's budget is kept by `deadlines` (kind `deadlines::JOB`, keyed by the job's source: registered in `admit`, forgotten in `finishJob`, delivered by `advance` or `advanceHeld` through `expireJob`: `timeout` said once, a dark job still waiting leaving the registry while the caller's source runs on, any other job keeping its record until its held work drains, no later label following); cohort selection stays the profile's decoder over `cohort_boundaries`; two consumers, shadow-layers over the atomic lifecycle and admission over the held served-job arm | `begin`, `release`, `admitJobs`, `admitServed`, `admits`, `admit`, `dropped`, `busy`, `acquired`, `settle`, `settleJob`, `sourceOutcome`, `fill`, `valuesMatch`, `matches`, `confirmation`, `finishJob`, `releaseDump`, `releaseWrite`, `expireJob`, `advance`, `settleJobHeld`, `settleJobLoad`, `settleJobRead`, `beginHeld`, `releaseHeld`, `settleRead`, `settleLoad`, `settleLoader`, `admitDark`, `dispatchC0`, `beginDark`, `settleHeld`, `recordVerdict`, `releaseRead`, `releaseLoad`, `expireHeld`, `advanceHeld`, `holdsJob`, `jobOf`, `sourceOf`, `duplicate`, `full`, `holdsRead`, `holdsLoad`, `latestRead`, `latestLoad`, `confirming` |
| `diagnostics` | The diagnostics channel (`d`, a row-polymorphic `Channel[q]` so a profile whose drivers compare more fields carries them beside the four every descriptor parses): the singleflight a caller coalesced into and the layer a failed source is attributed to, as diagnosed variants of the request-only traversal; and, as diagnosed variants of the budgeted held lifecycle (`DiagnosedHeld`) for a profile whose replies are immediate and whose reads settle at admission, the singleflight a follower coalesced into (`request_local`, or the process registry's `PROCESS_SCOPE`), the layer a flight is attributed to when it starts (`REMOTE_LAYER` for one that dispatched a read, whatever the read observed; the request memo or the shared layers' fallback for a source started without the remote layer; none for a bypass source started at admission), the fallback error recorded against that layer when the flight's failure is recorded (a late result that only drains records nothing) and the recovery age sampled when a recovery decode serves (`recordAge`, C57); each held variant judges the release once, through `deadlines::releaseJudged` (`admit`, the bypass attribution, and `releaseJudged`, the held release applied from a judgment and labelled from it, are the split `beginRead` composes with `deadlines::settleDispatched`, so a variant that admits work beside the held release, `shadow::beginDark`, judges once and applies them); the two fields the shadow drivers compare beside the four (`ShadowChannel`: the configuration errors a malformed shadow policy reports, `recordConfigError`, and the offsets of frames a shadow read found stamped after the wall clock, on the `remote_shadow` layer, `recordFutureOffset`, C57) and the warning a confirmed mismatch logs (`recordWarning`, C60), recorded by `shadow` at the moment each fact is known | `admitRequest`, `releaseRequest`, `settleRequest`, `admit`, `releaseJudged`, `beginRead`, `settleLoader`, `expireLoader`, `advance`, `settleLoad`, `recordAge`, `recordWarning`, `recordConfigError`, `recordFutureOffset` |
| `policy_overlay` | How a runtime policy overlay (the policy drivers' codes 0 to 25) resolves against a fixture's baseline TTLs: each layer's TTL, the retention a refill is written with, coalescing (codes 10 to 19 disable it), and whether the reply failed (a provider fault or an invalid read budget); the overlay decides the TTLs, the reply's layer set is the shape's (remote where remote storage exists), and the traversal gates each layer on its TTL at release (`layer_policy::gated`) | `failed`, `localTtl`, `remoteTtl`, `retention`, `ttls`, `resolve` |
| `config_errors` | The policy-error channel: a reply that fails to resolve is reported once, against no layer, as a `config_resolution` error; an opt-in record composed around the release whose reply failed | `recordConfigError` |
| `receipts` | The receipt of the latest release (the caller, its key, the layer that served it, that it started a source or joined a flight, and the local slot of its key as the release found it), for one-step expiry and freshness properties, as a receipted variant of the layered release judged once (`serving::layeredRelease`) and applied from that judgment (`serving::releaseJudged`) | `release` |

`cache_rules` (age, expiry, deadline and fence judgments) stays the layer under
these modules and is imported, never restated.

Every transition has the shape `pure def f(state: T[r], inputs...): T[r]` where
`T[r]` is a record type that names only the fields the module reads or writes
and leaves the rest of the profile's record open (`{ memo: List[int], closed:
List[bool] | r }`). A profile's state is therefore one flat record with exactly
the fields its fixtures need, and a transition applied to it returns the same
record type. Trace shape, the fixture projections and the trace readers are
unchanged by composition; a profile adds a field only when a module it composes
requires one.

Encodings are the drivers': caller outcomes are `conformance_observations`
codes, layer policy codes are `layer_policy`'s, storage slots hold the value or
0 and registries a source index or -1 (`encodings`). Layouts (keys per instance
and per scope row, persistent contexts, operations per entity, whether the
drivers probe each source's scope and whether they install a policy provider)
are passed as a `serving::Layout` record, so
a profile with a different bound composes the same transitions. A call is a
`calls::Call` (instance, key, context) and a policy reply resolves to a
`layer_policy::Resolution` (the enabled layers and whether the call coalesces)
with the `layer_policy::Ttls` the reply carries (the local insertion TTL, the
remote frame's freshness and the retention a refill is written with), which
every release and settlement takes beside the resolution; a profile whose
replies carry none passes its fixture's constant. A layer whose TTL is 0 is
off: the traversal uses local storage only for a positive local TTL and the
remote layer only for a positive freshness (`layer_policy::gated`), whatever
the reply's layer flags say. The TTLs settlement publishes with travel in the
source record, captured from the reply that started it
(`LayeredPayload.localMs` and `retentionMs`, `LocalPayload.localMs`), so each
source publishes with its own reply's TTLs and no settlement can disagree with
them; freshness is read only at release and travels beside the reply. The two
captured integers measured about x1.13 bytes per state on the layers profile
against the slice 8 base, inside the x1.2 differential bound; an earlier
three-integer payload that also carried the freshness settlement never reads
measured about x1.17 to x1.26 and was rejected. The serving transitions never decode a
profile's policy field: `layer_policy::resolution(policy, remote)` is the
immediate reply from the drivers' layer policy codes 0 to 5, which the layers
wrapper passes to `begin` with its TTLs; `runtime_policy::resolve(state,
samples)` resolves the runtime-boundaries drivers' codes 0 to 21 against the
instance's configured `Baseline`, which its wrapper passes to `release` the
same way; `BYPASS` is the reply of a call that uses no layer and neither
registry. Each profile owns its policy field with one meaning. A resolution
already reflects remote availability: the traversal reads the remote layer
whenever the resolution enables it, so a profile without remote storage
resolves `remote` to false (as `resolution` and `runtime_policy::resolve` do).

The layered shape also carries the remote adapter's fault switches
(`readFailed`, `dumpFailed`, `writeFailed`): a failed read is counted and
observes nothing, and the source it starts never refills; a refill serializes
(a dump), then dispatches the write, then stores the frame, a dump fault
stopping the dispatch and a write fault the storage. A profile whose drivers
inject no faults holds them false. `settle` settles a source with the TTLs its
own reply resolved to (the fixture's constant in a profile whose replies carry
none).

The traversal is one statement of the fall-through order (request memo, local,
remote, source) and of publication authority, split in time rather than by
concern: `admit` appends the caller, counts its policy call and holds it with
its call in the policy gate (a caller in a closed scope bypasses every layer
and starts its own unshared source at once), `release` traverses for the caller
held under a policy call with the state current at release and the resolution
the profile supplies (a scope closed since admission resolves to `BYPASS`), and
`begin` is their composition for a profile whose replies are immediate. A
profile whose drivers hold policy replies composes `admit` and `release` as
separate steps; releasing a policy call the gate does not hold is a modeling
error that fails in the gate's lookup, so a wrapper guards on the gate.
Per-concern entry points a profile would sequence are not offered: the order is
the rule, and the lint reports a branch between library transitions. A profile
composes an opt-in record after a transition when one of its own properties or
its drivers' channels needs it (`Flights::recordIdentity(Serving::begin(...), call)`,
`ConfigErrors::recordConfigError(..., failed(s))`), or a variant that
records beside the transition from the release judged once
(`Receipts::release`, like `Diagnostics::releaseRequest`). A variant that
records beside the layered release judges once through
`Serving::layeredRelease` and applies `Serving::releaseJudged`: `receipts`,
`remote_writes` and `shadow` all do, and `shadow` applies the judgment
through `remote_writes::releaseJudged`, so the traversal is judged once
however many records compose around it. Records the
traversal itself does not read are never mandatory fields.

The traversal has three shapes over one statement of the order (`decide`,
which joins a pending flight, serves the memo, the local value, the remote
value, or starts a source): the layered shape (`admit`, `release`, `settle`
over `Served`, whose source record `LayeredSource` carries publication
authority), the local projection (`admitLocal`, `releaseLocal`, `settleLocal`
over `LocalServed`, without a remote layer, whose `LocalSource` carries the
identity it serves and whether it may warm local storage) and the
request-only projection (`admitRequest`, `releaseRequest`, `settleRequest`
over `RequestServed`, whose `RequestSource` carries none and whose state names
no storage or clock). A projection exists only where the layered shape cannot
meet a profile's bytes-per-state bound (scope measured x1.37 layered against
x0.98 projected; source-budgets x1.5 layered); it passes fewer layer values to
`decide` and states no rule of its own. The projections carry the registry
fields of `Traversed`, `processFlights` among them although the request-only
shape never writes it, as the accepted cost of one `decide` over every shape.
Records only some profiles' drivers compare or bound compose as variants
around the same transitions: the `diagnostics` variants record the coalesced
scope and each source's layer, the `deadlines` variants register each
source's deadline and complete expired sources; a profile whose drivers do not
compare or bound them carries nothing.

A fact travels beside the traversal in one of three ways, chosen by who needs
it. A pre/post record is composed by the profile around a transition it names
(`Flights::recordIdentity`, `ConfigErrors::recordConfigError`): opt-in, but a
forgotten wrapper is invisible to the lint, so it suits only a fact one
profile's own property reads. A variant is a library transition over a wider
shape that records beside the transition it wraps (`Receipts::release`, the
`diagnostics` and `deadlines` variants): the wrapper cannot be forgotten
because it is the transition. A consulted record is a mandatory field a
library transition writes and reads where the fact arises (`remote_io`'s `io`
channel; the recovery `Snapshot`, created at read settlement from the
classifier argument and consulted at loader failure): it costs every profile
over the shape the field, and in exchange no composition order exists to get
wrong. The held remote lifecycle uses the last two: `deadlines` wraps
`remote_io` alone, and a profile without stale-on-error passes
`Recovery::NONE`. Where two variants of one rule differ only in the expiry
they run, the rule is one higher-order fold (`deadlines::deliver`) whose
operator is passed only inside the kernel; the lint reports any reference from
a profile's assigned value to a kernel definition that takes an operator
(declared inline or through a type alias), whatever the profile passes, so the
fold cannot become a hook for rule logic in a profile.

The wall clock is the monotonic clock plus a skew (`Clock::wallOf`): a profile
without wall-clock divergence holds `skew` at 0, one with rollbacks shifts it
(`Clock::shiftWall`), and `Clock::advance` is the one time transition, so a
frame's stamp can never fall behind a clock a profile forgot to move.

## Kernel fixtures

The library's transitions are pure, so the seams a scheduled profile may not
reach (held policy replies released out of order, coalescing off against both
registries, a scope closed between admission and release, the request-only
projection with its diagnostics, the budgeted local lifecycle with its expiry
boundaries, the held remote lifecycle with its recovery snapshots and read and
loader deadlines, a read settled in the step that admits its caller and the
diagnosed held lifecycle (the singleflight a follower coalesced into, the
layer a failed flight is attributed to, the recovery age), the payload
classes on both remote paths with the tracked retention cap, invalidation
marker lifetimes and expiry, the compression
channel, the shadow job registry over the atomic lifecycle with held writes:
atomic stale-on-error, a held dump fenced by a wall rollback, a dark fill's
C58 fence, dump and write faults and budgets delivered in registration order;
the local fault switch at admission and at settlement; the fractional clock
with inline sources and no policy provider; the served job registry over the
held remote lifecycle: the selection captured with the read and consulted at
the decode, the job's decode and confirmation read held by index, a timed-out
served job ending silently while its slot stays owned; dark jobs over the
diagnosed budgeted held lifecycle: a second dark job dropped while the first
holds its C0 read, the caller's source deadline and the job's budget delivered
in one round with the late read draining, the caller's deadline alone ending
a job under a longer budget)
are exercised by small profiles under `test/fixtures/kernel`. Each
typechecks and every run it declares passes: `make kernel-fixtures` runs them
locally with Quint on the PATH, and the model-check and differential lanes run
the same check.

## Composing a profile

`formal/dialcache-layers-conformance.qnt` is the first composed profile
(`formal/dialcache-runtime-boundaries-conformance.qnt` is the second, with held
policy replies and a runtime policy resolution; `formal/dialcache-scope-conformance.qnt`
the third, over the request-only projection with diagnostics;
`formal/dialcache-source-budgets-conformance.qnt` the fourth, over the budgeted
local projection; `formal/dialcache-policy-conformance.qnt` the fifth, with held
replies decoded by `policy_overlay` over the receipted layered release and the
config error record; `formal/dialcache-independent-conformance.qnt` the sixth,
over the budgeted held remote lifecycle with its recovery snapshots;
`formal/dialcache-recovery-read-conformance.qnt` the seventh, over the held
remote lifecycle with immediate replies, its recovery snapshots and payload
classes, the compression channel variants and the marker lifetime;
`formal/dialcache-shadow-layers-conformance.qnt` the eighth, over the atomic
layered release with held refills and stale-on-error on the atomic path, and
the shadow job registry with its budgets; `formal/dialcache-recovery-conformance.qnt`
the ninth, over the budgeted held lifecycle with the read settled at admission
and the diagnosed held variants;
`formal/dialcache-local-failure-conformance.qnt` the tenth, over the layered
traversal with the local fault switch read at admission and settlement;
`formal/dialcache-local-clock-conformance.qnt` the eleventh, over the local
projection with an inline source and the fractional clock, declaring
`policyProvider: false` because its default instances install no policy
provider, a drivers'-contract fact the layout states;
`formal/dialcache-admission-conformance.qnt` the twelfth, over the held remote
lifecycle with immediate replies and the shadow module's held served-job
lifecycle, the cohort selection captured with the caller's read and consulted
when its decode completes the hit). It keeps
its constants, its flat `State`, `var s` and `var input`, its `nondet` input
choices, its guards, its invariants and its regressions. Each wrapper action
assigns `s'` to one library transition and `input'` to the driver record:

```quint
action startCall(choice: int): bool = all {
  s.o.calls.length() < MAX_CALLERS,
  s' = Flights::recordIdentity(Serving::begin(s, LAYOUT, call(choice), resolution(s.policy, s.remoteAvailable), TTLS), call(choice)),
  input' = { name: "beginCall", choice: choice }
}
```

Each state field has one owning module: the request flight registry and the
per-caller record (owner, memo slot) belong to `flights`, which the scope
closure in `serving` asks to forget a closed scope's slots; the held callers
belong to `policy_gate` (empty in a profile with immediate replies); the caller
identity the ownership invariant reads is the opt-in record the wrapper
composes around `begin`; the clock and its wall skew belong to `clock`, the
frames with their stamps, retention and watermarks to `remote_frames`, and the
fault switches are environment inputs the wrapper sets by record update and the
traversal reads.
Composing `serving`
adopts the layers encoding of every field it names; a profile with a different
private layout re-encodes when it composes.

The rule adopted for witness classifiers is that they read the recorded
inputs and public observations only, as
[replay/witnesses/policy.mjs](../replay/witnesses/policy.mjs) does: a
classifier shadows the cache contents it needs from those, and the fidelity
check in policy.mjs binds the shadow to the model by comparing it, after every
step, with the model's private predictions wherever a history carries them. A
composition re-encodes that check against its new private layout and leaves
the classifiers alone, as the policy composition did (its `modelView` maps the
shadow to the layered shape). The scaffold those checks share (the test for a
history that carries private state, the layout guard and the step-by-step
comparison) is [replay/witnesses/fidelity.mjs](../replay/witnesses/fidelity.mjs);
a classifier hands `fidelityBinding` its public channels, the layout fields it
reads and the view that puts its shadow beside the model's state, and keeps
only its shadow and `modelView`. The classifiers still reading private
predictions, to migrate the same way (layers is already composed and still
owes this):
`effects.mjs`, `layers.mjs`, `recovery-shadow.mjs` (the shadow profile's
classifier), `shadow.mjs`, and the scope and layers rules of `runtime.mjs`;
`recovery.mjs` shadows the recovery profile from its inputs and channels and
binds the shadow to the composed layout in its fidelity check, and
`admission.mjs` binds its job and effect bookkeeping (live jobs by loader
ordinal, each held read and decode as a flight's or a job's, the registered
flights) to the composed admission layout the same way.

The rules a profile may keep are wiring: record literals for the initial state,
record updates with inputs (`{ policy: policy, ...s }`), and input decoding
that reads no state (`instance(context)`). Input decoding may also select
between two library transitions through guarded wrappers under `any` where a
branch between kernel results inside one wrapper would otherwise be needed
(recovery-read's `seedWith`: `seedAgedWith` and `seedUnsafeWith`, each guarded
on the input alone). This replays because `normalizeReplayInputs`
(`formal/replay-inputs.mjs`) overwrites `mbt::actionTaken` with the recorded
input name before any history is read, and `quint test --out-itf` exports carry
no MBT metadata, so the inner arm a sampled run records is never compared; do
not flatten the wrappers on seeing it in raw `quint run` output. Guards and
`nondet` domains restrict
the environment and may read state; invariants and runs are independent
statements and may read anything; the `input` assignment is the driver
contract and may branch on state.

`node formal/lint-profiles.mjs <profile.qnt>` checks this. Its composition rule
walks every value assigned to a state variable other than `input` from the
public wrappers and reports any comparison, branch, arithmetic or collection
operator whose operand carries cache state, and any non-library definition
applied to cache state, following profile helpers with the taint of their
arguments. Library modules are those declared under `formal/kernel`
(`cache_rules` is the judgment layer they consume, not one a profile assigns
through); a chosen `nondet` input and lambda parameters carry no state; a
kernel definition that takes an operator (a parameter declared with an
operator type, spelled inline or through a type alias such as `type Step[r] =
(Counter[r], int) => Counter[r]`, resolved to its typedef through a chain of
aliases if there is one; kernel definitions declare their parameter types, and
one without a declared type, or with an alias the parse does not resolve, is an
error rather than a definition taken for first-order; `deadlines::deliver` is
the one such definition today) may not be instantiated by a profile at all: a
reference to it from an assigned value, as the callee or by name, is reported
whatever the argument is (a kernel definition applied through a profile alias
such as `pure def repeatAlias = L::repeat` is judged and recorded as the
kernel's application), because the
library's folds take their operator only from kernel modules and an operator
written in a profile is rule logic the walk cannot follow; a record literal
may set a field over a library result (that is wiring the reviewer sees, not a
rule). `formal/profile-lint-baseline.json` records each
profile's library transitions and violation count; a composed profile reports
zero and the other counts are the migration list. `node formal/lint-profiles.mjs
baseline --check` is a step of `make differential` (the pull request lane) and
of `make formal-check` (the weekly full run); it is a ratchet: a profile's
library transitions and violation count must match the record (a count that
fell is refreshed with `--write`, one that rose fails), and a profile that
composes a kernel module may have none, whatever the record says. Arguments a
wrapper hands to a parametrized action are walked where they are written and
taint the callee's parameters. The lint sees the shape of assignments, not
their meaning: a record literal that overrides a library result passes it; the
corpus differential is the behavioral check.

## Migrating a profile

A rewrite lands when the corpus differential agrees on every history:

```bash
node formal/differential.mjs layers --reference=origin/main
```

The tool generates the profile's corpus and exports its regressions from the
merge base with the reference revision and from the working tree, each with
its own manifest entry (invariants, bounds, seed) and the generation lane's
command. It then replays every reference history through the working tree's
text as a deterministic schedule of its public inputs, and every working-tree
history through the reference text, comparing every channel the drivers
assert at every step; a candidate that enables inputs the reference refused
disagrees in the reverse direction. Replays run as batched `quint test`
processes (16 histories each, the measured optimum) built from constrained
action clones shared across the batch, the same schedules fixture recipes use.
The run fails on any disagreement and when trace bytes per state grow beyond
1.2 times the reference's, or beyond the model's own
`differential.maxBytesPerStateRatio` when it declares one (the reason belongs
in the record table below); generation wall time is recorded and reported as
advisory above 1.5, because the two generations run concurrently and hosted
runners are noisy. What is compared is what the drivers assert (the
observation and the profile's side channels); private state is protected by
the generation-time invariants and the witness lanes, not by this tool.

The report records the import closure of both texts (the profile and every
Quint source it reaches) with per-file digests, so a red run on a kernel-only
change names the module that changed.

An intended change of observable behavior is declared in the manifest: bump
the model's `differential.behaviorVersion` in `formal/execution.json` in the
same change (or the profile's observation schema `version` in
`formal/profiles.json` when the driver-asserted channels change), and the
differential reports the profile as an intended divergence instead of
comparing it. A profile the reference revision does not generate is reported
as new, and one the working tree no longer generates as removed (the manifest
validator already forbids registering a profile without generating it). The
differential replays only profiles with an explicit-input driver descriptor in
`formal/replay/features.mjs` (or, for local-clock, in
`formal/replay/local-clock.mjs`), whose recorded `input.choice` is the wrapper's
`nondet` choice; a composed profile without one fails the run by name. The
local-clock descriptor's `actionBindings` (with `boundAction` and their tests)
is transitional: it schedules a history through a reference text from before
the wrapper rename, where `call` is the parametrized action and `callCache`
the public wrapper, and is deleted once the merge base with main carries the
renamed text. `make
differential` runs the lint baseline check and then the differential for every
profile that imports a kernel module in either revision (directly or through a
helper library); the pull request lane runs that against the base branch
whenever a Quint input changes and preserves the reports and replay logs.

Fault challenges for rules that moved into the library anchor on the module
source (every `formal/kernel/*.qnt` is a library because no scheduled model
claims it, which puts it under the purity check and the witness evidence
inputs; the fixture lock pins the modules the recipe models import) and are
measured through the composing profile's scheduled invariant, as before. A
composition also re-measures every existing shared-library challenge over the
newly composed profile (its scheduled invariants at the exploration bound and
all its regressions under the mutant): the profile joins
`reproducer.profiles` where it detects the fault, and its exclusion reason is
restated for the composed text where it does not.

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

| Rewrite | Measured | Histories agreeing | Generation wall (advisory) | Bytes per state | Profile lines | Lint violations |
| --- | --- | --- | --- | --- | --- | --- |
| recovery | 2026-09-20 against 2add082 (the read settled in its step, the held release split from its judgment, the diagnosed held lifecycle) | 512 of 512 and 30 of 30 | 11.6 s -> 21.0 s (x1.80) | 1544 -> 2769 (x1.793, bound x1.85, model) | 466 -> 443 | 80 -> 0 |
| local-failure | 2026-09-20 against 75d709e (the fractional clock, the inline local call, the newest source and the policy-provider layout fact) | 128 of 128 and 5 of 5 | 0.8 s -> 1.7 s (x1.95) | 1056 -> 1477 (x1.399, bound x1.45, model) | 169 -> 215 | 24 -> 0 |
| local-clock | 2026-09-20 against 75d709e (the same head) | 128 of 128 and 4 of 4 | 1.6 s -> 2.2 s (x1.34) | 2904 -> 1819 (x0.626) | 139 -> 168 | 11 -> 0 |
| admission | 2026-09-20 against 56bb2bb (the lint denylist, the case audit folded into semantic-cases, the shared fidelity scaffold, the derived go-parity sections) | 128 of 128 and 6 of 6 / 8 of 8 | 2.8 s -> 6.1 s (x2.17) | 3024 -> 4910 (x1.624, bound x1.65, model) | 455 -> 368 | 65 -> 0 |

The pilot that preceded the library (#171, #172) instantiated one kernel state
machine per profile and measured its cost; its conclusions and measurements are
recorded in issue #165.
