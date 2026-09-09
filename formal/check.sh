#!/usr/bin/env bash
set -euo pipefail

# Keep both successful samples and failing counterexamples for local/CI replay.
mkdir -p .formal-traces/verification

check() {
  local spec="$1"
  shift

  echo "::group::quint typecheck ${spec}"
  quint typecheck "${spec}"
  echo "::endgroup::"

  echo "::group::quint run ${spec}"
  quint run "${spec}" --backend=rust --n-threads=1 \
    --seed="${QUINT_SEED:-0xd1a1ca}" --max-samples=2000 --max-steps=40 \
    --out-itf=".formal-traces/verification/$(basename "${spec}" .qnt).itf.json" \
    --verbosity=1 --invariants "$@"
  echo "::endgroup::"
}

check formal/dialcache-core.qnt \
  failedLocalReadSkipsReuseAndPublication \
  failedLocalWritePreservesAcceptedResult \
  closedScopeHasNoRequestValue \
  requestValueBelongsToCurrentScope \
  passThroughSkipsCacheMachinery \
  firstHitStopsLowerTraversal \
  remoteFailureNeverRefills \
  trackedRemoteFallbackSuppressesLocalPublication \
  onePolicySnapshotPerEnabledInvocation

quint test formal/dialcache-core.qnt --backend=rust --max-samples=1

check formal/dialcache-runtime-policy.qnt \
  runtimeOverlayIsLeafWise \
  configuredTtlImpliesDefaultFullRamp \
  featureLibraryDefaults \
  existingLocalEntryKeepsInsertionTtl \
  existingRemoteEntryKeepsPhysicalTtl

quint test formal/dialcache-runtime-policy.qnt --backend=rust --max-samples=1

check formal/dialcache-coalescing-liveness.qnt \
  flightsRequireEligibleCaching \
  oneSourcePerRegisteredFlight \
  fallbackDeadlineStartsWithFallback \
  timedOutSourceCannotPublish \
  publicationRequiresAcceptedSource \
  noFlightWhenCoalescingIneligible \
  abandonedSourceIsNotAFlight

quint test formal/dialcache-coalescing-liveness.qnt --backend=rust --max-samples=1

check formal/dialcache-tracked-invalidation.qnt \
  servedSnapshotClearedObservedFence \
  staleValueAfterInvalidationIsFenced \
  acquiredAfterInvalidationDoesNotServeStale

check formal/dialcache-stale-recovery.qnt \
  recoveryUsesSingleRedisRead \
  retainedCandidateWasEligible \
  servedStaleIsStrictlyWithinMaxAge \
  staleRequiresAuthorizedSourceFailure \
  sourceSuccessDoesNotDecodeCandidate \
  recoveredStaleHasNoSharedPublication \
  readFailureNeverRetains \
  readFailureNeverAttemptsRecovery

quint test formal/dialcache-stale-recovery.qnt --backend=rust --max-samples=1

check formal/dialcache-shadow-validation.qnt \
  comparisonAndFillWaitForSource \
  completedVerdictRequiresSource \
  ordinaryRemoteMissHasNoShadowJob \
  rampedDownDoesNotDuplicateSource \
  verdictsRequireSingleConfirmation \
  mismatchMeansSameC1Bytes \
  presentC0IsNeverRepaired \
  fillsRequireMiss \
  fencedFillDoesNotWrite

quint test formal/dialcache-shadow-validation.qnt --backend=rust --max-samples=1

check formal/dialcache-redis-protocol.qnt \
  nilValueIsValueAbsent \
  fenceCanPrecedeEncodingError \
  malformedWatermarkPrecedesEncodingError \
  trackedZeroTimestampIsNotHit \
  observedWatermarkOnlyOnTrackedReads \
  encodingErrorRequiresSupportedFrame

quint test formal/dialcache-redis-protocol.qnt --backend=rust --max-samples=1

check formal/dialcache-conformance.qnt \
  loaderCountsNonNegative \
  redisCountsNonNegative \
  readableRemoteHasValue

check formal/dialcache-effects-conformance.qnt \
  oneRegisteredSource \
  registeredFlightHasPendingCalls \
  writeRequiresAcceptedSource \
  registeredReadOwnsFlight effectCountsMatchRecords oneRequestPerRead oneSourceDurationPerSettlement measurementsAreNonnegative

quint test formal/dialcache-effects-conformance.qnt --backend=rust --max-samples=1

check formal/dialcache-recovery-conformance.qnt \
  singleReadPerFlight pendingDecodeHasCall writesHaveRetention sourcesMatchEffects onlyRegisteredSourceOwnsDeadline agesRequireRecovery closedScopesHaveNoMemo
quint test formal/dialcache-recovery-conformance.qnt --backend=rust --max-samples=1

check formal/dialcache-policy-conformance.qnt \
  writesHaveRetention hitsSkipSource callsKeepSourceOutcome sourceCountsMatchEffects registeredSourcesArePending sharedSourcesKeepRegistration

quint test formal/dialcache-policy-conformance.qnt --backend=rust --max-samples=1

check formal/dialcache-shadow-conformance.qnt \
  oneSourcePerCaller writesRequireMiss writesHaveRetention agesRequireVerdicts warningsRequireMismatch missingHookHasNoShadowEffects
quint test formal/dialcache-shadow-conformance.qnt --backend=rust --max-samples=1

check formal/dialcache-scope-conformance.qnt \
  closedScopesHaveNoMemo registeredSourcesArePending callsKeepSourceOutcome sourceCountsMatchEffects
quint test formal/dialcache-scope-conformance.qnt --backend=rust --max-samples=1

check formal/dialcache-admission-conformance.qnt \
  capacityIsPerInstance oneJobPerIdentity registeredCallsArePending callsKeepAcquiredValue jobsAreDiagnostic effectsMatchRecords
quint test formal/dialcache-admission-conformance.qnt --backend=rust --max-samples=1

check formal/dialcache-layers-conformance.qnt \
  sourceEffectsMatch capacityIsPerInstance closedScopesHaveNoMemo registeredSourcesArePending zeroCapacityHasNoLocalValues callsKeepSourceOutcome localMembershipMatchesLru absentRemoteHasNoAdapterEffects
quint test formal/dialcache-layers-conformance.qnt --backend=rust --max-samples=1

check formal/dialcache-independent-conformance.qnt \
  oneReadPerCall effectsMatchOwners completedCallsHaveNoActiveWork retainedSnapshotsWereEligible abortsAreUnique writesKeepCapturedRetention
quint test formal/dialcache-independent-conformance.qnt --backend=rust --max-samples=1
