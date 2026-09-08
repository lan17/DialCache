#!/usr/bin/env bash
set -euo pipefail

check() {
  local spec="$1"
  shift

  echo "::group::quint typecheck ${spec}"
  quint typecheck "${spec}"
  echo "::endgroup::"

  echo "::group::quint run ${spec}"
  quint run "${spec}" --max-samples=2000 --max-steps=40 --invariants "$@"
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
