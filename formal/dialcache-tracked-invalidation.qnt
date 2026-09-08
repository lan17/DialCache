module dialcache_tracked_invalidation {
  // First-pass model of the tracked Redis invalidation protocol.
  //
  // Scope:
  //   - one invalidation entity / one tracked value key
  //   - atomic value + watermark snapshots
  //   - one pre-mutation load that may complete after invalidation
  //   - conditional refill using the watermark observed by the read
  //   - bounded writer delay / clock lead assumptions
  //
  // Deliberately out of scope for this model:
  //   local caches, request scopes, coalescing, stale-on-error, shadow reads,
  //   serialization/compression, Redis failures, retries, and TTL expiry.

  type ReadPhase = ReadIdle | ReadAcquired | ReadServed | ReadMissed

  // Small finite bounds keep random simulation and explicit-state checking useful.
  pure val MAX_TIME = 8
  pure val FUTURE_BUFFER_MS = 4
  pure val MAX_STALE_WRITE_DELAY_MS = 3
  pure val MAX_WRITER_CLOCK_LEAD_MS = 1

  // The deployment assumption documented by DialCache:
  // futureBufferMs must cover delayed stale work plus writer clock lead.
  pure val bufferCoversStaleWrites =
    FUTURE_BUFFER_MS >= MAX_STALE_WRITE_DELAY_MS + MAX_WRITER_CLOCK_LEAD_MS

  var now: int
  var sourceVersion: int
  var mutationCommitted: bool
  var invalidatedAt: int

  var watermark: int
  var valuePresent: bool
  var valueCreatedAt: int
  var valueSourceVersion: int

  var loadInFlight: bool
  var loadSourceVersion: int

  var readPhase: ReadPhase
  var snapshotPresent: bool
  var snapshotCreatedAt: int
  var snapshotSourceVersion: int
  var snapshotWatermark: int

  action init = all {
    now' = 0,
    sourceVersion' = 0,
    mutationCommitted' = false,
    invalidatedAt' = 0,

    watermark' = 0,
    valuePresent' = false,
    valueCreatedAt' = 0,
    valueSourceVersion' = 0,

    loadInFlight' = false,
    loadSourceVersion' = 0,

    readPhase' = ReadIdle,
    snapshotPresent' = false,
    snapshotCreatedAt' = 0,
    snapshotSourceVersion' = 0,
    snapshotWatermark' = 0,
  }

  // Time is intentionally discrete and bounded. The model is about ordering and
  // fence inequalities, not real millisecond magnitudes.
  action advanceTime = all {
    now < MAX_TIME,
    now' = now + 1,
  }

  // A source read captures the version that was authoritative when it began.
  // Starting it before commit models stale work that can finish afterwards.
  action startLoad = all {
    not(loadInFlight),
    loadInFlight' = true,
    loadSourceVersion' = sourceVersion,
  }

  // Mutation commit and remote invalidation are collapsed into one transition.
  // DialCache requires invalidateRemote() after source commit; the watermark is
  // monotonic and proposed as invalidator time + futureBufferMs.
  action commitAndInvalidate = all {
    not(mutationCommitted),
    mutationCommitted' = true,
    sourceVersion' = sourceVersion + 1,
    invalidatedAt' = now,
    watermark' = if (watermark > now + FUTURE_BUFFER_MS)
      watermark
    else
      now + FUTURE_BUFFER_MS,
  }

  // Complete a loader and dispatch the Redis SET. A pre-mutation load completing
  // after invalidation is constrained by the documented Dmax assumption.
  // We conservatively stamp with the maximum allowed writer clock lead.
  action completeLoadWrite = all {
    loadInFlight,
    or {
      loadSourceVersion == sourceVersion,
      and {
        mutationCommitted,
        loadSourceVersion < sourceVersion,
        now <= invalidatedAt + MAX_STALE_WRITE_DELAY_MS,
      },
    },
    valuePresent' = true,
    valueCreatedAt' = now + MAX_WRITER_CLOCK_LEAD_MS,
    valueSourceVersion' = loadSourceVersion,
    loadInFlight' = false,
  }

  // Tracked reads atomically observe the value and watermark. Later invalidation
  // must not retroactively mutate this acquired snapshot.
  action acquireTrackedRead = all {
    readPhase == ReadIdle,
    snapshotPresent' = valuePresent,
    snapshotCreatedAt' = valueCreatedAt,
    snapshotSourceVersion' = valueSourceVersion,
    snapshotWatermark' = watermark,
    readPhase' = ReadAcquired,
  }

  // DialCache's tracked acceptance rule is strict: createdAtMs > watermarkMs.
  // We omit age/payload checks here; those belong to later model slices.
  action finishTrackedRead = all {
    readPhase == ReadAcquired,
    readPhase' = if (snapshotPresent and snapshotCreatedAt > snapshotWatermark)
      ReadServed
    else
      ReadMissed,
  }

  // Start another independent read after the previous result has been observed.
  action resetRead = all {
    readPhase != ReadIdle,
    readPhase != ReadAcquired,
    readPhase' = ReadIdle,
  }

  // Model the conditional-refill check after a tracked miss. The refill uses the
  // watermark observed by that same atomic read; it does not issue another read.
  // If the dispatch timestamp cannot clear that observed fence, DialCache skips it.
  action conditionalRefill = all {
    readPhase == ReadMissed,
    not(loadInFlight),
    if (now + MAX_WRITER_CLOCK_LEAD_MS <= snapshotWatermark)
      readPhase' = ReadIdle
    else
      all {
        valuePresent' = true,
        valueCreatedAt' = now + MAX_WRITER_CLOCK_LEAD_MS,
        valueSourceVersion' = sourceVersion,
        readPhase' = ReadIdle,
      },
  }

  action step = any {
    advanceTime,
    startLoad,
    commitAndInvalidate,
    completeLoadWrite,
    acquireTrackedRead,
    finishTrackedRead,
    resetRead,
    conditionalRefill,
  }

  // Every served result was accepted against the watermark captured in the same
  // atomic Redis snapshot. It need not be newer than the *current* watermark,
  // because invalidation after acquisition does not revoke an existing snapshot.
  val servedSnapshotClearedObservedFence =
    readPhase != ReadServed or
      (snapshotPresent and snapshotCreatedAt > snapshotWatermark)

  // Under the Dmax + clock-lead assumption, a stale pre-mutation write that lands
  // after invalidation is fenced by the watermark and cannot pass a later read.
  val staleValueAfterInvalidationIsFenced =
    not(bufferCoversStaleWrites) or
    not(mutationCommitted) or
    not(valuePresent) or
    valueSourceVersion >= sourceVersion or
    valueCreatedAt <= watermark

  // A read acquired after invalidation cannot serve a stale source version.
  // Reads acquired before invalidation are intentionally allowed to finish later.
  val acquiredAfterInvalidationDoesNotServeStale =
    readPhase != ReadServed or
    snapshotWatermark < watermark or
    snapshotSourceVersion >= sourceVersion
}
