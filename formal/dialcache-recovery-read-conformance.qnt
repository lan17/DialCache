module dialcache_recovery_read_conformance {
  import conformance_observations.* from "./conformance-observations"
  import encodings.* from "./kernel/encodings"
  import calls.* from "./kernel/calls"
  import layer_policy.* from "./kernel/layer-policy"
  import serving as Serving from "./kernel/serving"
  import remote_io as RemoteIO from "./kernel/remote-io"
  import recovery as Recovery from "./kernel/recovery"
  import remote_frames as Remote from "./kernel/remote-frames"
  import markers as Markers from "./kernel/markers"
  import compression as Compression from "./kernel/compression"
  import payloads as Payloads from "./kernel/payloads"
  import clock as Clock from "./kernel/clock"
  import policy_gate as Gate from "./kernel/policy-gate"
  // Model boundary -----------------------------------------------------------
  // One tracked or untracked operation crosses request, local and remote
  // storage. Reads and decoding can wait; successful source publication settles
  // within its action. C22/C28/C37/C38/C43/C45 are the selected contracts.
  // Two request scopes and one transient caller distinguish request memo from
  // process-local reuse. Only one execution is active: concurrent ownership and
  // source/read deadlines remain in the independent/effects profiles. The read
  // budget exceeds the entire elapsed-time domain; sources are explicitly
  // unbounded. Logical age and native retention remain independent.
  // See BEHAVIOR.md: "Additional composition profiles" for this profile's row
  // and replay/profiles/recovery-read.mjs for the drivers' input mapping (the
  // seed codes 0..18, the policy codes and the advance choices).
  // Every rule is a kernel transition (formal/kernel): the held remote
  // traversal (remote_io) with its recovery snapshots (recovery) and payload
  // classes (payloads) over the layered shape, admitted and released in one
  // step (RemoteIO::begin: replies are immediate); the two settlements that
  // hold a decode through the compression channel variants (compression); the
  // invalidation marker's lifetime and expiry (markers); the frames a seed
  // stores (remote_frames). This module owns the bounded state, the fixture
  // decoding (the payload code, age and retention a seed choice names, the
  // TTLs a policy code resolves to), the input choices and the guards. `now`
  // is elapsed time; the wall clock is `now` plus the drivers' origin.

  // Trace encodings and fixture bounds ---------------------------------------
  // Initialization choices are part of the replay input: keep these codes stable.
  pure val UNTRACKED_MODE = 0
  pure val TRACKED_MODE = 1
  pure val TRACKED_WITH_SHADOW_MODE = 2
  pure val KEY = 0
  pure val ENTITY = 0
  pure val WALL_ORIGIN = 1000000000
  pure val READ_BUDGET_MS = 30000000
  pure val MAX_ELAPSED_MS = 14400000
  pure val MAX_CALLS = 10
  // The drivers' unsafe-timestamp fixture (replay/profiles/recovery-read.mjs,
  // seed 16): a frame stamped at 2^53 + 1, above every wall clock the profile
  // reaches. Stored as it is, cache_rules does the rest: a stamp after the
  // observed wall fails every age judgment (never fresh, never a candidate)
  // and clears the fence (the raw compare), so its miss refills unfenced, as
  // the implementations treat an unsafe stamp.
  pure val UNSAFE_STAMP_MS = 9007199254740993
  // One key on one instance, two persistent request scopes (contexts 0 and 1;
  // context 2 is a transient caller), one operation per entity; the drivers
  // never probe a source's scope.
  pure val LAYOUT: Serving::Layout = {
    keysPerInstance: 1, keysPerScope: 1, persistentContexts: 2, operationsPerEntity: 1, probeSourceScope: false, policyProvider: true
  }
  // Every reply enables every layer and coalesces, as the implementation's
  // default policy does (layer_policy::resolution(ALL_LAYERS, true)); with
  // one execution at a time no caller ever finds a flight to join.
  pure val ALL: Resolution = { layers: { request: true, local: true, remote: true }, coalesce: true }
  pure def call(context: int): Call = { instance: 0, key: KEY, context: context, enabled: true, keyFailed: false }

  // State: the layered shape with its held remote effects, recovery snapshots
  // and marker lifetime, the four driver channels (o, io, markers,
  // compression), the policy in force (`ttls`: the local insertion TTL, the
  // remote freshness and the retention that is also the recovery maximum,
  // captured by each held read at admission) and the shadow selection that
  // restricts the inputs of mode 2.
  type State = {
    o: Observation, io: RemoteIO::IO, markers: List[Markers::Marker], compression: List[str],
    now: int, skew: int, remoteAvailable: bool, tracked: bool, shadowSelected: bool, capacity: int,
    readFailed: bool, dumpFailed: bool, writeFailed: bool,
    closed: List[bool], memo: List[int], requestFlights: List[int], processFlights: List[int],
    localValues: List[int], localExpires: List[int], lru: List[List[int]],
    remoteValues: List[int], created: List[int], expires: List[int], watermark: List[int], markerExpires: List[int],
    sources: List[Serving::LayeredSource], owners: List[int], memoSlots: List[int], held: List[Gate::Held],
    reads: List[RemoteIO::HeldRead], loads: List[RemoteIO::HeldLoad], loaders: List[int], retained: List[Recovery::Snapshot],
    ttls: Ttls
  }
  var s: State
  // These are external replay commands, never predicted observations. The
  // explicit record survives deterministic `quint test --out-itf` exports.
  var input: { name: str, choice: int }

  // Input decoding (reads no state) ------------------------------------------
  // The TTLs a policy code resolves to: a 1 s local insertion TTL, 1 s remote
  // freshness (2 h under code 2) and the recovery maximum as the retention.
  pure def ttlsOf(code: int): Ttls = {
    localMs: 1000,
    freshMs: if (code == 2) 7200000 else 1000,
    retentionMs: if (code == 2) 14400000 else if (code == 1) 7200000 else 5000
  }
  // External fixtures: codes select actual raw/enveloped bytes, age and
  // physical lifetime. Compressed bodies are fixed portable zstd examples in
  // the driver; the payload code states their decode outcome (payloads), not
  // the compression algorithm. Code 17 is a frame of an unsupported version,
  // which the adapter reads as a miss, so it is stored as absence; code 16 is
  // the unsafe stamp, stored by `seedUnsafeWith`.
  pure def seedAge(code: int): int =
    List(0, 999, 1000, 4999, 5000, 3600001, 7200000, 0, 1000, 1000, 0, 0, 4999, 0, 0, 1000, 0, 0, 1000).nth(code)
  pure def seedPayload(code: int): int =
    if (code == 7) VALUE_TWO
    else if (code == 8 or code == 12 or code == 13) Payloads::COMPRESSED + VALUE_ONE
    else if (code == 9 or code == 14) Payloads::CORRUPT + VALUE_ONE
    else if (code == 10) Payloads::UNSUPPORTED_ENCODING
    else if (code == 17) NO_VALUE
    else if (code == 18) VALUE_ABSENT
    else VALUE_ONE
  pure def seedRetention(code: int): int = if (code == 11 or code == 15) 1000 else 60000

  // Initial fixture: no frame, no watermark, no marker, empty local and
  // request storage, one local slot, the policy of code 0 in force.
  // TRACKED_WITH_SHADOW_MODE isolates recovery with a selected shadow policy:
  // only stale bytes and failed sources are admitted in this mode (the seed
  // and loader guards), so fresh-hit diagnostic jobs remain in the shadow
  // profiles.
  action initialized(mode: int): bool = all {
    input' = { name: "init", choice: mode },
    s' = {
      o: empty, io: RemoteIO::NO_IO, markers: List(), compression: List(),
      now: 0, skew: WALL_ORIGIN, remoteAvailable: true, tracked: mode != UNTRACKED_MODE,
      shadowSelected: mode == TRACKED_WITH_SHADOW_MODE, capacity: 1,
      readFailed: false, dumpFailed: false, writeFailed: false,
      closed: List(false, false), memo: List(NO_VALUE, NO_VALUE), requestFlights: List(NO_OWNER, NO_OWNER), processFlights: List(NO_OWNER),
      localValues: List(NO_VALUE), localExpires: List(0), lru: List(List()),
      remoteValues: List(NO_VALUE), created: List(0), expires: List(0), watermark: List(0), markerExpires: List(0),
      sources: List(), owners: List(), memoSlots: List(), held: List(),
      reads: List(), loads: List(), loaders: List(), retained: List(),
      ttls: ttlsOf(0)
    }
  }
  action init = {
    nondet choice = Set(UNTRACKED_MODE, TRACKED_MODE, TRACKED_WITH_SHADOW_MODE).oneOf()
    initialized(choice)
  }

  // Guards (may read state) ---------------------------------------------------
  // One execution at a time: a caller is admitted only while none is pending,
  // and the drivers settle the latest effect (the held read, the held decode,
  // the newest loader) rather than one by index. During a recovery decode the
  // flight already records its source error, so `decoding` is what excludes
  // a loader settlement then.
  val idle = s.o.calls.select(c => c == CALL_PENDING).length() == 0
  val reading = s.reads.length() > 0
  val decoding = s.loads.length() > 0
  val running = not(reading) and not(decoding) and s.loaders.length() > 0 and
    s.sources.nth(s.loaders.nth(s.loaders.length() - 1)).result == CALL_PENDING

  // Admission and the held release in one step: request and local hits stop
  // the traversal (a local hit never renews insertion), otherwise the read is
  // dispatched under the read budget and its flight captures the policy in
  // force (C45). Contexts 0/1 own persistent request memos; context 2 is a
  // transient caller. ---------------------------------------------------------
  action beginIn(context: int): bool = all {
    idle,
    s.o.calls.length() < MAX_CALLS,
    context == 2 or not(s.closed.nth(context)),
    input' = { name: "beginCall", choice: context },
    s' = RemoteIO::begin(s, LAYOUT, call(context), ALL, s.ttls, READ_BUDGET_MS)
  }
  action beginCall = { nondet choice = Set(0, 1, 2).oneOf(); beginIn(choice) }

  // External settlement of the latest effect. The adapter observes current
  // storage when its held read settles: freshness samples the settlement wall
  // clock (C22), an unsupported encoding fails the read once the frame is
  // present and fence-cleared (C28), and the compression variants report the
  // outcome of the decode a settlement holds (C59). Under `oneExecution` at
  // most one read and one decode are held, so RemoteIO::latestRead,
  // latestLoad (the last held record) and latestOrdinal (the newest loader)
  // are the drivers' latest dispatched effect: `observed.reads - 1`,
  // `observed.loads - 1` and `observed.loaders - 1` in
  // replay/profiles/recovery-read.mjs. -----------------------------------------
  action releaseRead = all {
    reading,
    input' = { name: "releaseRead", choice: -1 },
    s' = Compression::settleRead(s, LAYOUT, RemoteIO::latestRead(s).read, false, Recovery::ALLOW)
  }
  action rejectLoader = all {
    running,
    input' = { name: "rejectLoader", choice: -1 },
    s' = Compression::settleLoader(s, LAYOUT, RemoteIO::latestOrdinal(s), SOURCE_ERROR, false)
  }
  action resolveLoader = all {
    running,
    not(s.shadowSelected),
    input' = { name: "resolveLoader", choice: -1 },
    s' = Compression::settleLoader(s, LAYOUT, RemoteIO::latestOrdinal(s), VALUE_TWO, false)
  }
  // Decoding holds the acquired bytes. Fresh hits warm process storage after
  // successful decode; retained recovery can publish only to its live request.
  action releaseLoad = all {
    decoding,
    input' = { name: "releaseLoad", choice: -1 },
    s' = RemoteIO::settleLoad(s, LAYOUT, RemoteIO::latestLoad(s).load, false)
  }

  // Environmental storage, clocks, policy, scopes and maintenance -------------
  // A seed stores a frame at an age (`seedAgedWith`) or, for code 16, the
  // drivers' literal unsafe stamp (`seedUnsafeWith`): two wrappers guarded on
  // the input alone and selected under `any`, so each assigns exactly one
  // library transition. Only stale bytes and failed sources are admitted in
  // shadow mode; absence is stored data (code 18, shadow mode only) and
  // NO_VALUE still means that the remote key itself does not exist.
  action seedAgedWith(code: int): bool = all {
    code != 16,
    not(s.shadowSelected) or code == 2 or code == 18,
    s.shadowSelected or code != 18,
    input' = { name: "seed", choice: code },
    s' = Remote::seedAged(s, KEY, seedPayload(code), seedAge(code), seedRetention(code))
  }
  action seedUnsafeWith(code: int): bool = all {
    code == 16,
    not(s.shadowSelected),
    input' = { name: "seed", choice: code },
    s' = Remote::storeFrame(s, KEY, VALUE_ONE, UNSAFE_STAMP_MS, seedRetention(code))
  }
  action seedWith(code: int): bool = any { seedAgedWith(code), seedUnsafeWith(code) }
  action seed = { nondet choice = 0.to(18).oneOf(); seedWith(choice) }
  // Time passes through the markers' advance, which expires a lapsed marker.
  action advanceBy(ms: int): bool = all {
    s.now + ms <= MAX_ELAPSED_MS,
    input' = { name: "advance", choice: ms },
    s' = Markers::advance(s, ms)
  }
  action advance = { nondet choice = Set(1, 999, 1000, 4000, 60000, 3600000).oneOf(); advanceBy(choice) }
  action policyWith(code: int): bool = all {
    not(s.shadowSelected),
    input' = { name: "policy", choice: code },
    s' = { ttls: ttlsOf(code), ...s }
  }
  action policy = { nondet choice = Set(0, 1, 2).oneOf(); policyWith(choice) }
  action closeContext(context: int): bool = all {
    not(s.closed.nth(context)),
    input' = { name: "closeScope", choice: context },
    s' = Serving::closeScope(s, LAYOUT, context)
  }
  action closeScope = { nondet choice = Set(0, 1).oneOf(); closeContext(choice) }
  // Invalidation owns marker creation and extension (markers). Read and
  // value-write actions never update marker state; the separate command
  // observes the marker's external cutoff and TTL against the drivers' origin.
  action invalidate = all {
    input' = { name: "invalidate", choice: -1 },
    s' = Markers::invalidate(s, ENTITY, 0)
  }
  action observeMarker = all {
    input' = { name: "observeMarker", choice: -1 },
    s' = Markers::observe(s, ENTITY, WALL_ORIGIN)
  }
  action writeFaultWith(code: int): bool = all {
    input' = { name: "writeFault", choice: code },
    s' = { writeFailed: code == 1, ...s }
  }
  action writeFault = { nondet choice = Set(0, 1).oneOf(); writeFaultWith(choice) }
  // Exploration schedule: preserve grouping and order for seeded sampling.
  action step = any {
    beginCall, releaseRead, rejectLoader, resolveLoader, releaseLoad,
    seed, advance, policy, closeScope, invalidate, observeMarker, writeFault
  }

  // Invariants: independent checks over ownership and observed history. -----
  // Over the public channels: a closed scope holds no memo (C03); a selected
  // shadow policy admits no diagnostic work and a recovered result publishes
  // nothing (C47; one local slot, never evicted, so an untouched slot reads
  // NO_VALUE); every io row and every write TTL has an owner.
  val closedContextsStayEmpty = s.closed.indices().forall(i => not(s.closed.nth(i)) or s.memo.nth(i) == 0)
  val selectedShadowNeverAdmitsRecoveredResults = not(s.shadowSelected) or
    (s.o.shadow == List() and s.o.dumps == 0 and s.o.writes == 0 and s.localValues == List(NO_VALUE))
  val observationsHaveOwners = s.io.sourceErrors.length() == s.o.calls.length() and
    s.io.budgets.length() == s.o.reads and s.o.writeTtls.length() == s.o.writes
  // Every write is retained for the policy's 5 s, or for the tracked cap when
  // a policy asks a tracked entity for more, or for the policy's full 2 h or
  // 4 h when untracked (C37); the requested retention survives nowhere in the
  // state once the authority caps it, so the exact per-write pairing with the
  // admitted maximum is the connection model's sourcesCarryCappedAdmittedRetention.
  val trackedWritesRespectPhysicalCap = s.o.writeTtls.indices().forall(i => {
    val ttl = s.o.writeTtls.nth(i)
    ttl == 5000 or (s.tracked and ttl == Remote::TRACKED_RETENTION_CAP_MS) or
      (not(s.tracked) and (ttl == 7200000 or ttl == 14400000))
  })
  // Over the library records: the drivers' loaders are the loader ordinals,
  // and every held effect is one the drivers dispatched.
  val effectsMatchOwners = s.o.loaders == s.loaders.length() and
    s.reads.indices().forall(i => s.reads.nth(i).read < s.o.reads) and
    s.loads.indices().forall(i => s.loads.nth(i).load < s.o.loads)
  // A completed caller either owns no flight (it was served from the request
  // memo or local storage: serving attaches NO_OWNER to a layer-served
  // caller, which independent never sees because its every caller dispatches
  // a read) or owns one whose result is recorded and on which no read or
  // decode is still held.
  val completedCallsHaveNoActiveWork = s.o.calls.indices().forall(c => s.o.calls.nth(c) == CALL_PENDING or {
    val flight = s.owners.nth(c)
    flight < 0 or (s.sources.nth(flight).result != CALL_PENDING and
      s.reads.indices().forall(j => s.reads.nth(j).flight != flight) and
      s.loads.indices().forall(j => s.loads.nth(j).flight != flight))
  })
  // The environment restriction stated: one execution at a time, so at most
  // one read, one decode and one snapshot are held and one caller is pending.
  val oneExecution = s.reads.length() <= 1 and s.loads.length() <= 1 and s.retained.length() <= 1 and
    s.o.calls.select(c => c == CALL_PENDING).length() <= 1
  // A marker no longer in force fences nothing: its entity's watermark is at
  // the zero baseline (markers).
  val expiredMarkersFenceNothing = s.markerExpires.indices().forall(e =>
    s.now < s.markerExpires.nth(e) or s.watermark.nth(e) == 0)

  // Deterministic model regressions ------------------------------------------
  // A selected policy, outcome hook and available capacity make shadow work
  // otherwise eligible. Neither ordinary recovery nor its request-memo probe
  // may create a diagnostic source or any shared-cache publication.
  run recoveredAbsenceSkipsSelectedShadowTest = initialized(TRACKED_WITH_SHADOW_MODE).then(seedWith(18))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ABSENT) and s.o.loaders == 1 and s.o.reads == 1
      and s.o.loads == 1 and s.o.classifications == 1 and s.o.recovery == List("served")
      and s.o.shadow == List() and s.o.dumps == 0 and s.o.writes == 0)
    .then(beginIn(0))
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT) and s.o.loaders == 1 and s.o.reads == 1
      and s.o.shadow == List() and s.o.dumps == 0 and s.o.writes == 0)
    .then(beginIn(1)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ABSENT, VALUE_ABSENT, VALUE_ABSENT)
      and s.o.loaders == 2 and s.o.reads == 2 and s.o.loads == 2
      and s.o.recovery == List("served", "served") and s.o.shadow == List()
      and s.o.dumps == 0 and s.o.writes == 0 and s.localValues == List(NO_VALUE))
  run recoveredValueSkipsSelectedShadowTest = initialized(TRACKED_WITH_SHADOW_MODE).then(seedWith(2))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .then(beginIn(0))
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.loaders == 1 and s.o.reads == 1
      and s.o.loads == 1 and s.o.classifications == 1 and s.o.recovery == List("served")
      and s.o.shadow == List() and s.o.dumps == 0 and s.o.writes == 0 and s.localValues == List(NO_VALUE))

  // Deterministic replay uses only the same external commands as exploration.
  run freshnessAfterHeldReadTest = initialized(TRACKED_MODE).then(seedWith(0)).then(beginIn(2))
    .then(advanceBy(1000)).then(releaseRead)
    .expect(s.o.loaders == 1 and s.o.loads == 0)
    .then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served") and s.o.writes == 0)
  run trackedEncodingFailureSuppressesRefillTest = initialized(TRACKED_MODE).then(seedWith(10))
    .then(beginIn(0)).then(releaseRead).then(resolveLoader)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)
    .then(beginIn(1)).expect(s.o.reads == 2 and s.o.calls == List(VALUE_TWO, CALL_PENDING))
  run untrackedEncodingFailureStillPublishesLocalTest = initialized(UNTRACKED_MODE).then(seedWith(10))
    .then(beginIn(0)).then(releaseRead).then(resolveLoader).then(beginIn(1))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 1
      and s.o.loads == 0 and s.o.dumps == 0 and s.o.writes == 0)
  // A read failed by the frame's encoding retains no snapshot, so the loader
  // failure that follows is unclassified: the caller completes with the
  // loader's own error, no recovery label is reported, nothing is decoded or
  // written.
  run encodingFailedReadLeavesNoCandidateTest = initialized(TRACKED_MODE).then(seedWith(10))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader)
    .expect(s.o.calls == List(SOURCE_ERROR) and s.io.sourceErrors == List(1) and s.o.classifications == 0
      and s.o.recovery == List() and s.o.loads == 0 and s.o.writes == 0)
  run trackedPhysicalRetentionExpiresAtCapTest = initialized(TRACKED_MODE).then(policyWith(2))
    .then(beginIn(2)).then(releaseRead).then(resolveLoader)
    .expect(s.o.writeTtls == List(3600000))
    .then(advanceBy(3600000)).then(beginIn(2)).then(releaseRead)
    .expect(s.o.calls == List(VALUE_TWO, CALL_PENDING) and s.o.loaders == 2 and s.o.loads == 0)
  // The untracked twin: the policy's full 4 h retention is written.
  run untrackedRetentionIsNotCappedTest = initialized(UNTRACKED_MODE).then(policyWith(2))
    .then(beginIn(2)).then(releaseRead).then(resolveLoader)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.dumps == 1 and s.o.writes == 1 and s.o.writeTtls == List(14400000))
  // The snapshot keeps the reply's 2 h maximum while the source captured the
  // capped retention; a candidate an hour and a millisecond old still serves.
  run physicalCapDoesNotClampLogicalRecoveryTest = initialized(TRACKED_MODE).then(policyWith(1))
    .then(seedWith(5)).then(beginIn(2)).then(releaseRead)
    .expect(Clock::wallOf(s) - s.retained.nth(0).created == 3600001 and s.retained.nth(0).maximum == 7200000
      and s.sources.nth(0).retentionMs == 3600000)
    .then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served") and s.o.writeTtls == List())
  run compressedRecoveryMemoizesWithoutLocalPublicationTest = initialized(TRACKED_MODE).then(seedWith(8))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .then(beginIn(0)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(beginIn(1)).expect(s.o.reads == 2 and s.o.calls == List(VALUE_ONE, VALUE_ONE, CALL_PENDING))
    .expect(s.o.dumps == 0 and s.o.writes == 0 and s.localValues == List(NO_VALUE))
  run corruptCompressedRecoveryKeepsOriginalSourceErrorTest = initialized(TRACKED_MODE).then(seedWith(9))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .expect(s.o.calls == List(SOURCE_ERROR) and s.io.sourceErrors == List(1)
      and s.o.recovery == List("deserialization_error") and s.o.loads == 1
      and s.o.dumps == 0 and s.o.writes == 0)
  run retainedCompressedRecoverySurvivesInvalidationTest = initialized(TRACKED_MODE).then(seedWith(8))
    .then(beginIn(0)).then(releaseRead).then(invalidate).then(rejectLoader).then(releaseLoad)
    .then(beginIn(0)).expect(s.o.calls == List(VALUE_ONE, VALUE_ONE) and s.o.reads == 1)
    .then(beginIn(1)).then(releaseRead).then(rejectLoader)
    .expect(s.o.calls == List(VALUE_ONE, VALUE_ONE, SOURCE_ERROR) and s.io.sourceErrors == List(0, 0, 2)
      and s.o.recovery == List("served", "miss") and s.o.loads == 1 and s.o.writes == 0)
  run closedRequestCannotReceiveCompressedRecoveryTest = initialized(TRACKED_MODE).then(seedWith(8))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(closeContext(0)).then(releaseLoad)
    .then(beginIn(1)).expect(s.o.calls == List(VALUE_ONE, CALL_PENDING) and s.o.reads == 2)
    .expect(s.memo == List(NO_VALUE, NO_VALUE) and s.localValues == List(NO_VALUE) and s.o.writes == 0)
  run trackedSourceNeedsRemoteValidationBeforeLocalReuseTest = initialized(TRACKED_MODE)
    .then(beginIn(0)).then(releaseRead).then(resolveLoader).then(beginIn(0))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 1)
    .then(beginIn(1)).then(releaseRead).then(releaseLoad).then(beginIn(2))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO, VALUE_TWO, VALUE_TWO)
      and s.o.reads == 2 and s.o.loaders == 1 and s.o.loads == 1)
  // A memo row belongs to its scope: closing another scope leaves this
  // scope's memo, which the next same-scope caller reuses without a read.
  run closingAnotherScopeKeepsThisScopesMemoTest = initialized(TRACKED_MODE)
    .then(beginIn(0)).then(releaseRead).then(resolveLoader)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.reads == 1 and s.o.loaders == 1)
    .then(closeContext(1)).then(beginIn(0))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 1 and s.o.loaders == 1)
  // A local entry serves until, not at, its insertion TTL: the transient
  // caller hits at 999 ms and reads at 1000 ms.
  run localEntryExpiresAtItsInsertionTtlTest = initialized(UNTRACKED_MODE)
    .then(beginIn(2)).then(releaseRead).then(resolveLoader)
    .then(advanceBy(999)).then(beginIn(2))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 1)
    .then(advanceBy(1)).then(beginIn(2))
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO, CALL_PENDING) and s.o.reads == 2 and s.o.loaders == 1)
  run ordinaryValueWorkDoesNotCreateMarkerTest = initialized(TRACKED_MODE).then(observeMarker)
    .then(beginIn(2)).then(releaseRead).then(resolveLoader).then(observeMarker)
    .then(beginIn(2)).then(releaseRead).then(releaseLoad).then(observeMarker)
    .expect(s.markers == List({ cutoffMs: -1, ttlMs: -2 },
      { cutoffMs: -1, ttlMs: -2 }, { cutoffMs: -1, ttlMs: -2 }))
  run ordinaryValueWorkDoesNotExtendMarkerTest = initialized(TRACKED_MODE).then(invalidate).then(observeMarker)
    .then(advanceBy(1)).then(policyWith(2)).then(beginIn(2)).then(releaseRead).then(resolveLoader)
    .then(observeMarker).then(beginIn(2)).then(releaseRead).then(releaseLoad).then(advanceBy(999)).then(observeMarker)
    .expect(s.markers == List({ cutoffMs: 0, ttlMs: 7200000 },
      { cutoffMs: 0, ttlMs: 7199999 }, { cutoffMs: 0, ttlMs: 7199000 }))
  // The marker lapses at its two-hour floor: the probe then reads no marker,
  // and the next invalidation stamps a fresh floor marker at the new cutoff.
  run expiredMarkerIsGoneTest = initialized(TRACKED_MODE).then(invalidate).then(observeMarker)
    .expect(s.markers == List({ cutoffMs: 0, ttlMs: 7200000 }))
    .then(advanceBy(3600000)).then(advanceBy(3600000)).then(observeMarker)
    .expect(s.markers == List({ cutoffMs: 0, ttlMs: 7200000 }, { cutoffMs: -1, ttlMs: -2 }))
    .then(invalidate).then(observeMarker)
    .expect(s.o.invalidations == 2 and s.markers == List({ cutoffMs: 0, ttlMs: 7200000 },
      { cutoffMs: -1, ttlMs: -2 }, { cutoffMs: 7200000, ttlMs: 7200000 }))
  // Once the marker lapses, the frame stamped exactly at its cutoff is
  // un-fenced on the public channels: stale under the 2 h freshness, the read
  // holds no decode, the loader's failure finds it a recovery candidate, and
  // the held decode serves it without a write.
  run lapsedMarkerUnfencesTheFrameStampedAtItsCutoffTest = initialized(TRACKED_MODE).then(invalidate)
    .then(advanceBy(3600000)).then(advanceBy(3600000)).then(seedWith(6)).then(policyWith(2))
    .then(beginIn(0)).then(releaseRead)
    .expect(s.o.loaders == 1 and s.o.loads == 0)
    .then(rejectLoader)
    .expect(s.o.loads == 1 and s.o.calls == List(CALL_PENDING))
    .then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.recovery == List("served") and s.o.writes == 0)

  run failedInvalidationPreservesExistingMarkerTest = initialized(TRACKED_MODE).then(invalidate).then(observeMarker)
    .then(advanceBy(1000)).then(writeFaultWith(1)).then(invalidate).then(observeMarker)
    .expect(s.o.maintenance == List("ok", "mutation_error"))
    .expect(s.markers == List({ cutoffMs: 0, ttlMs: 7200000 }, { cutoffMs: 0, ttlMs: 7199000 }))
  run failedInvalidationDoesNotCreateMarkerTest = initialized(TRACKED_MODE).then(writeFaultWith(1))
    .then(invalidate).then(observeMarker)
    .expect(s.o.maintenance == List("mutation_error") and s.markers == List({ cutoffMs: -1, ttlMs: -2 }))
  run freshCompressedReadReportsDecompressionTest = initialized(TRACKED_MODE).then(seedWith(13))
    .then(beginIn(0)).then(releaseRead)
    .expect(s.compression == List("decompressed") and s.o.calls == List(CALL_PENDING))
    .then(releaseLoad).expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0 and s.o.loads == 1)
  run corruptCompressedReadReportsRawFallbackTest = initialized(TRACKED_MODE).then(seedWith(14))
    .then(beginIn(0)).then(releaseRead).expect(s.compression == List("fallback_raw"))
    .then(releaseLoad).then(resolveLoader)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.loads == 1 and s.o.loaders == 1 and s.o.writes == 1)

  run heldReadJustBeforeFreshnessBoundaryStillHitsTest = initialized(TRACKED_MODE).then(seedWith(0))
    .then(beginIn(2)).then(advanceBy(999)).then(releaseRead).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_ONE) and s.o.loaders == 0 and s.o.loads == 1 and s.o.recovery == List())
  run untrackedCompressedRecoveryDoesNotWarmLocalTest = initialized(UNTRACKED_MODE).then(seedWith(8))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader).then(releaseLoad)
    .then(beginIn(1)).expect(s.o.calls == List(VALUE_ONE, CALL_PENDING)
      and s.o.reads == 2 and s.localValues == List(NO_VALUE) and s.o.dumps == 0 and s.o.writes == 0)
  run compressedRecoveryRechecksMaximumAfterDecodeTest = initialized(TRACKED_MODE).then(seedWith(12))
    .then(beginIn(0)).then(releaseRead).then(rejectLoader)
    .expect(s.compression == List("decompressed") and s.o.calls == List(CALL_PENDING))
    .then(advanceBy(1)).then(releaseLoad)
    .expect(s.o.calls == List(SOURCE_ERROR) and s.io.sourceErrors == List(1)
      and s.o.recovery == List("miss") and s.o.dumps == 0 and s.o.writes == 0)

  // The retained bytes belong to the call. Native expiration affects the next
  // read, but cannot revoke that earlier snapshot while its logical age is valid.
  run retainedSnapshotSurvivesPhysicalExpiryTest = initialized(TRACKED_MODE).then(seedWith(15))
    .then(beginIn(0)).then(releaseRead).then(advanceBy(1000)).then(rejectLoader).then(releaseLoad)
    .then(beginIn(1)).then(releaseRead).then(rejectLoader)
    .expect(s.o.calls == List(VALUE_ONE, SOURCE_ERROR) and s.io.sourceErrors == List(0, 2)
      and s.o.loads == 1 and s.o.reads == 2 and s.o.recovery == List("served", "miss")
      and s.o.dumps == 0 and s.o.writes == 0)

  run unsafeTimestampSkipsSerializerAndAllowsRefillTest = initialized(TRACKED_MODE).then(seedWith(16))
    .then(beginIn(0)).then(releaseRead).expect(s.o.loads == 0 and s.o.loaders == 1)
    .then(resolveLoader).then(beginIn(1)).then(releaseRead).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 2
      and s.o.loaders == 1 and s.o.loads == 1 and s.o.dumps == 1 and s.o.writes == 1)
  // A frame whose unsafe stamp lies above the watermark raised at the same
  // instant is visible and never fresh: its miss carries no fence and refills.
  run unsafeTimestampAtTheWatermarkStillRefillsTest = initialized(TRACKED_MODE).then(invalidate).then(seedWith(16))
    .then(beginIn(0)).then(releaseRead).expect(s.o.loads == 0 and s.o.loaders == 1)
    .then(resolveLoader)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.dumps == 1 and s.o.writes == 1 and s.o.writeTtls == List(5000))
  run unsupportedVersionSkipsSerializerAndAllowsRefillTest = initialized(TRACKED_MODE).then(seedWith(17))
    .then(beginIn(0)).then(releaseRead).expect(s.o.loads == 0 and s.o.loaders == 1)
    .then(resolveLoader).then(beginIn(1)).then(releaseRead).then(releaseLoad)
    .expect(s.o.calls == List(VALUE_TWO, VALUE_TWO) and s.o.reads == 2
      and s.o.loaders == 1 and s.o.loads == 1 and s.o.dumps == 1 and s.o.writes == 1)
  // The version miss carries the fence a miss observes: under a watermark
  // raised at the same instant, the refill stamped then does not clear it,
  // so nothing is dumped or written.
  run unsupportedVersionUnderRaisedWatermarkIsAFencedMissTest = initialized(TRACKED_MODE).then(invalidate).then(seedWith(17))
    .then(beginIn(0)).then(releaseRead).expect(s.o.loads == 0 and s.o.loaders == 1)
    .then(resolveLoader)
    .expect(s.o.calls == List(VALUE_TWO) and s.o.dumps == 0 and s.o.writes == 0 and s.o.writeTtls == List()
      and s.o.reads == 1 and s.localValues == List(NO_VALUE))

  run maximumAgeBeforeDecodeKeepsOriginalErrorTest = initialized(TRACKED_MODE).then(seedWith(12))
    .then(beginIn(0)).then(releaseRead).then(advanceBy(1)).then(rejectLoader)
    .expect(s.o.calls == List(SOURCE_ERROR) and s.io.sourceErrors == List(1)
      and s.o.loads == 0 and s.compression == List() and s.o.recovery == List("miss")
      and s.o.dumps == 0 and s.o.writes == 0)

  // An absent read acquired the zero baseline. Invalidation before settlement
  // does not retroactively change that receipt, so the source still writes.
  // The write's equal timestamp is fenced for a subsequent independent read.
  run laterInvalidationDoesNotRewriteObservedMissFenceTest = initialized(TRACKED_MODE)
    .then(beginIn(0)).then(releaseRead).then(invalidate).then(resolveLoader)
    .then(beginIn(1)).then(releaseRead)
    .expect(s.o.loads == 0 and s.o.loaders == 2)
    .then(rejectLoader)
    .expect(s.o.calls == List(VALUE_TWO, SOURCE_ERROR) and s.io.sourceErrors == List(0, 2)
      and s.o.dumps == 1 and s.o.writes == 1 and s.o.loads == 0 and s.o.reads == 2
      and s.o.recovery == List("miss"))
}
