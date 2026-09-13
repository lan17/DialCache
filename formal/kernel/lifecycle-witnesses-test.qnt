module lifecycle_witnesses_test {
  import lifecycle_witnesses.* from "./lifecycle-witnesses"

  // Synthetic observation fixtures challenge the monitor itself. These are
  // never exported as positive implementation-conformance histories.
  pure def observed(name: str, choice: int, calls: List[int], now: int,
    reads: int, loaders: int, dumps: int, writes: int): Step = {
    input: { name: name, choice: choice },
    observation: { calls: calls, now: now, reads: reads, loaders: loaders, dumps: dumps, writes: writes }
  }
  pure val initialized = observed("init", 2, List(), 0, 0, 0, 0, 0)
  pure val sharedSource = List(initialized,
    observed("beginCall", -1, List(0), 0, 1, 0, 0, 0),
    observed("beginCall", -1, List(0, 0), 0, 1, 0, 0, 0),
    observed("releaseRead", 0, List(0, 0), 0, 1, 1, 0, 0))
  pure val sharedSuccess = sharedSource.concat(List(
    observed("resolveLoader", 0, List(0, 0), 0, 1, 1, 1, 0),
    observed("releaseDump", -1, List(0, 0), 0, 1, 1, 1, 1),
    observed("releaseWrite", -1, List(1, 1), 0, 1, 1, 1, 1)))
  pure val sharedFailure = sharedSource.append(observed("rejectLoader", 0, List(3, 3), 0, 1, 1, 0, 0))
  pure val replacement = List(initialized,
    observed("beginCall", -1, List(0), 0, 1, 0, 0, 0),
    observed("releaseRead", 0, List(0), 0, 1, 1, 0, 0),
    observed("tick", -1, List(4), 10, 1, 1, 0, 0),
    observed("beginCall", -1, List(4, 0), 10, 2, 1, 0, 0),
    observed("releaseRead", 1, List(4, 0), 10, 2, 2, 0, 0))
  pure val accepted = List(initialized,
    observed("beginCall", -1, List(0), 0, 1, 0, 0, 0),
    observed("releaseRead", 0, List(0), 0, 1, 1, 0, 0),
    observed("resolveLoader", 0, List(0), 0, 1, 1, 1, 0))

  var labels: Set[str]
  action check(history: List[Step], held: bool): bool =
    labels' = reached(history, held, 10)

  run coalescingNeedsSuccessfulCallerOutcomesTest = check(sharedSource, true)
    .expect(not(labels.contains("coalesced-success")))
    .then(check(sharedSuccess, true)).expect(labels.contains("coalesced-success"))

  run publicationNeedsLaterCompletedHitTest = check(sharedSuccess, true)
    .expect(not(labels.contains("published-value-reused")))
    .then(check(sharedSuccess.concat(List(
      observed("beginCall", -1, List(1, 1, 0), 0, 2, 1, 1, 1),
      observed("releaseRead", 1, List(1, 1, 0), 0, 2, 1, 1, 1))), true))
    .expect(not(labels.contains("published-value-reused")))
    .then(check(sharedSuccess.concat(List(
      observed("beginCall", -1, List(1, 1, 0), 0, 2, 1, 1, 1),
      observed("releaseRead", 1, List(1, 1, 0), 0, 2, 1, 1, 1),
      observed("releaseLoad", -1, List(1, 1, 1), 0, 2, 1, 1, 1))), true))
    .expect(labels.contains("published-value-reused"))

  run sharedFailureNeedsSuccessfulNewExecutionTest = check(sharedFailure, true)
    .expect(not(labels.contains("shared-failure-retry")))
    .then(check(sharedFailure.concat(List(
      observed("beginCall", -1, List(3, 3, 0), 0, 2, 1, 0, 0),
      observed("releaseRead", 1, List(3, 3, 0), 0, 2, 2, 0, 0),
      observed("rejectLoader", 1, List(3, 3, 3), 0, 2, 2, 0, 0))), true))
    .expect(not(labels.contains("shared-failure-retry")))
    .then(check(sharedFailure.concat(List(
      observed("beginCall", -1, List(3, 3, 0), 0, 2, 1, 0, 0),
      observed("releaseRead", 1, List(3, 3, 0), 0, 2, 2, 0, 0),
      observed("resolveLoader", 1, List(3, 3, 0), 0, 2, 2, 1, 0),
      observed("releaseDump", -1, List(3, 3, 0), 0, 2, 2, 1, 1),
      observed("releaseWrite", -1, List(3, 3, 1), 0, 2, 2, 1, 1))), true))
    .expect(labels.contains("shared-failure-retry"))

  run overlapNeedsHarmlessOldSettlementTest = check(replacement, true)
    .expect(not(labels.contains("abandoned-source-replacement")))
    .then(check(replacement.append(observed("resolveLoader", 0, List(4, 1), 10, 2, 2, 0, 0)), true))
    .expect(not(labels.contains("abandoned-source-replacement")))
    .then(check(replacement.append(observed("resolveLoader", 0, List(4, 0), 10, 2, 2, 1, 0)), true))
    .expect(not(labels.contains("abandoned-source-replacement")))
    .then(check(replacement.append(observed("resolveLoader", 0, List(4, 0), 10, 2, 2, 0, 0)), true))
    .expect(labels.contains("abandoned-source-replacement"))

  run acceptedPreparationAndWriteMustCrossDeadlineTest = check(accepted.concat(List(
    observed("releaseDump", -1, List(0), 0, 1, 1, 1, 1),
    observed("tick", -1, List(0), 10, 1, 1, 1, 1),
    observed("releaseWrite", -1, List(1), 10, 1, 1, 1, 1))), true)
    .expect(not(labels.contains("accepted-publication-after-deadline")))
    .then(check(accepted.concat(List(
      observed("tick", -1, List(0), 10, 1, 1, 1, 0),
      observed("releaseDump", -1, List(0), 10, 1, 1, 1, 1),
      observed("tick", -1, List(0), 20, 1, 1, 1, 1))), true))
    .expect(not(labels.contains("accepted-publication-after-deadline")))
    .then(check(accepted.concat(List(
      observed("tick", -1, List(0), 10, 1, 1, 1, 0),
      observed("releaseDump", -1, List(0), 10, 1, 1, 1, 1),
      observed("tick", -1, List(0), 20, 1, 1, 1, 1),
      observed("releaseWrite", -1, List(1), 20, 1, 1, 1, 1))), true))
    .expect(labels.contains("accepted-publication-after-deadline"))

  run lateAcceptanceCannotEarnPublicationLabelTest = check(List(initialized,
    observed("beginCall", -1, List(0), 0, 1, 0, 0, 0),
    observed("releaseRead", 0, List(0), 0, 1, 1, 0, 0),
    observed("jumpClock", -1, List(0), 10, 1, 1, 0, 0),
    observed("resolveLoader", 0, List(0), 10, 1, 1, 1, 0),
    observed("releaseDump", -1, List(0), 10, 1, 1, 1, 1),
    observed("releaseWrite", -1, List(1), 10, 1, 1, 1, 1)), true)
    .expect(not(labels.contains("accepted-publication-after-deadline")))

  pure val lateSource = List(initialized,
    observed("beginCall", -1, List(0), 0, 1, 0, 0, 0),
    observed("releaseRead", 0, List(0), 0, 1, 1, 0, 0),
    observed("jumpClock", -1, List(0), 10, 1, 1, 0, 0))
  run exactDeadlineSettlementRequiresTimeoutAndNoPublicationTest = check(lateSource, true)
    .expect(not(labels.contains("late-resolve-rejected")) and not(labels.contains("late-reject-rejected")))
    .then(check(lateSource.append(observed("resolveLoader", 0, List(1), 10, 1, 1, 0, 0)), true))
    .expect(not(labels.contains("late-resolve-rejected")))
    .then(check(lateSource.append(observed("rejectLoader", 0, List(3), 10, 1, 1, 0, 0)), true))
    .expect(not(labels.contains("late-reject-rejected")))
    .then(check(lateSource.append(observed("resolveLoader", 0, List(4), 10, 1, 1, 1, 0)), true))
    .expect(not(labels.contains("late-resolve-rejected")))
    .then(check(lateSource.append(observed("resolveLoader", 0, List(4), 10, 1, 1, 0, 0)), true))
    .expect(labels.contains("late-resolve-rejected"))
    .then(check(lateSource.append(observed("rejectLoader", 0, List(4), 10, 1, 1, 0, 0)), true))
    .expect(labels.contains("late-reject-rejected"))

  run layersImmediatePublicationAndSameIdentityProbeTest = check(List(initialized,
    observed("beginCall", 0, List(0), 0, 1, 1, 0, 0),
    observed("beginCall", 4, List(0, 0), 0, 1, 1, 0, 0),
    observed("resolveLoader", 1, List(1, 1), 0, 1, 1, 1, 1),
    observed("beginCall", 12, List(1, 1, 1), 0, 1, 1, 1, 1)), false)
    .expect(labels == Set("coalesced-success", "published-value-reused"))

  run differentIdentityCannotSupplyPublicationProbeTest = check(List(initialized,
    observed("beginCall", 0, List(0), 0, 1, 1, 0, 0),
    observed("resolveLoader", 1, List(1), 0, 1, 1, 1, 1),
    observed("beginCall", 16, List(1, 1), 0, 2, 1, 1, 1)), false)
    .expect(not(labels.contains("published-value-reused")))

  pure val futureFrame = List(initialized,
    observed("invalidate", -1, List(), 0, 0, 0, 0, 0),
    observed("tick", -1, List(), 10, 0, 0, 0, 0),
    observed("seedRemote", -1, List(), 10, 0, 0, 0, 0),
    observed("rollbackWall", -1, List(), 10, 0, 0, 0, 0),
    observed("beginCall", -1, List(0), 10, 1, 0, 0, 0),
    observed("releaseRead", 0, List(0), 10, 1, 1, 0, 0),
    observed("resolveLoader", 0, List(0), 10, 1, 1, 1, 0),
    observed("releaseDump", -1, List(0), 10, 1, 1, 1, 1),
    observed("releaseWrite", -1, List(1), 10, 1, 1, 1, 1))
  run futureFrameNeedsSourcePublicationConsequenceTest = check(futureFrame.slice(0, 8), true)
    .expect(not(labels.contains("future-frame-refills-after-source")))
    .then(check(futureFrame.replaceAt(7, observed("resolveLoader", 0, List(1), 10, 1, 1, 0, 0)), true))
    .expect(not(labels.contains("future-frame-refills-after-source")))
    .then(check(futureFrame.replaceAt(9, observed("releaseWrite", -1, List(0), 10, 1, 1, 1, 1)), true))
    .expect(not(labels.contains("future-frame-refills-after-source")))
    .then(check(futureFrame, true)).expect(labels.contains("future-frame-refills-after-source"))
}
