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
  closedScopeHasNoRequestValue \
  passThroughSkipsCacheMachinery \
  firstHitStopsLowerTraversal \
  remoteFailureNeverRefills \
  trackedRemoteFallbackSuppressesLocalPublication \
  onePolicySnapshotPerEnabledInvocation

check formal/dialcache-runtime-policy.qnt \
  runtimeOverlayIsLeafWise \
  configuredTtlImpliesDefaultFullRamp \
  featureLibraryDefaults \
  existingLocalEntryKeepsInsertionTtl \
  existingRemoteEntryKeepsPhysicalTtl

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
  readFailureNeverRetains

quint test formal/dialcache-stale-recovery.qnt --backend=rust --max-samples=1

check formal/dialcache-shadow-validation.qnt \
  shadowNeverPrecedesCallerResult \
  ordinaryRemoteMissHasNoShadowJob \
  rampedDownDoesNotDuplicateSource \
  verdictsRequireSingleConfirmation \
  mismatchMeansSameC1Bytes \
  presentC0IsNeverRepaired \
  fillsRequireMiss \
  fencedFillDoesNotWrite

check formal/dialcache-redis-protocol.qnt \
  nilValueIsValueAbsent \
  fenceCanPrecedeEncodingError \
  trackedZeroTimestampIsNotHit \
  observedWatermarkOnlyOnTrackedReads \
  encodingErrorRequiresSupportedFrame

check formal/dialcache-conformance.qnt \
  loaderCountsNonNegative \
  redisCountsNonNegative \
  readableRemoteHasValue
