module dialcache_tracked_invalidation {
  // Model of the tracked Redis invalidation protocol.
  //
  // Scope:
  //   - one invalidation entity / one tracked value key
  //   - atomic value + watermark snapshots
  //   - one pre-mutation load that may complete after invalidation
  //   - conditional refill using the watermark observed by the read
  //   - bounded writer delay / clock lead assumptions

  type ReadPhase = ReadIdle | ReadAcquired | ReadServed | ReadMissed

  pure val MAX_TIME = 8
  pure val FUTURE_BUFFER_MS = 4
  pure val MAX_STALE_WRITE_DELAY_MS = 3
  pure val MAX_WRITER_CLOCK_LEAD_MS = 1

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

  action advanceTime = all {
    now < MAX_TIME,
    now' = now + 1,
  }

  action startLoad = all {
    not(loadInFlight),
    loadInFlight' = true,
    loadSourceVersion' = sourceVersion,
  }

  // Mutation commit and invalidation are collapsed into one transition. The
  // proposal is monotonic and includes the configured future buffer.
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

  // A pre-mutation load can finish after invalidation, but only within the
  // deployment's bounded stale-work assumption.
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

  // Tracked reads atomically acquire value and watermark. Later invalidation
  // cannot mutate this already-acquired snapshot.
  action acquireTrackedRead = all {
    readPhase == ReadIdle,
    snapshotPresent' = valuePresent,
    snapshotCreatedAt' = valueCreatedAt,
    snapshotSourceVersion' = valueSourceVersion,
    snapshotWatermark' = watermark,
    readPhase' = ReadAcquired,
  }

  action finishTrackedRead = all {
    readPhase == ReadAcquired,
    readPhase' = if (snapshotPresent and snapshotCreatedAt > snapshotWatermark)
      ReadServed
    else
      ReadMissed,
  }

  action resetRead = all {
    readPhase != ReadIdle,
    readPhase != ReadAcquired,
    readPhase' = ReadIdle,
  }

  // Conditional refill uses only the fence observed by the original atomic
  // miss. Both the pre-serialization and pre-dispatch checks abstract to this
  // timestamp predicate; neither performs another Redis read.
  action conditionalRefill = all {
    readPhase == ReadMissed,
    not(loadInFlight),
    valuePresent' = if (now + MAX_WRITER_CLOCK_LEAD_MS <= snapshotWatermark)
      valuePresent
    else
      true,
    valueCreatedAt' = if (now + MAX_WRITER_CLOCK_LEAD_MS <= snapshotWatermark)
      valueCreatedAt
    else
      now + MAX_WRITER_CLOCK_LEAD_MS,
    valueSourceVersion' = if (now + MAX_WRITER_CLOCK_LEAD_MS <= snapshotWatermark)
      valueSourceVersion
    else
      sourceVersion,
    readPhase' = ReadIdle,
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

  // Every served result cleared the watermark captured in the same atomic
  // snapshot. It need not clear the current watermark after later invalidation.
  val servedSnapshotClearedObservedFence =
    readPhase != ReadServed or
      (snapshotPresent and snapshotCreatedAt > snapshotWatermark)

  // Under the documented delay/skew bound, stale pre-mutation work remains
  // fenced even when its SET lands after invalidation.
  val staleValueAfterInvalidationIsFenced =
    not(bufferCoversStaleWrites) or
    not(mutationCommitted) or
    not(valuePresent) or
    valueSourceVersion >= sourceVersion or
    valueCreatedAt <= watermark

  // A read that acquired the current invalidation snapshot cannot serve an old
  // source version. A pre-invalidation snapshot is intentionally allowed to
  // finish later.
  val acquiredAfterInvalidationDoesNotServeStale =
    readPhase != ReadServed or
    snapshotWatermark < watermark or
    snapshotSourceVersion >= sourceVersion
}