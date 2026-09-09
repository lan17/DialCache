#!/usr/bin/env bash
set -euo pipefail

# This directory is generated output owned by this script. Clear only this
# profile so old traces cannot silently join a new corpus.
mkdir -p .formal-traces
rm -rf .formal-traces/conformance
mkdir -p .formal-traces/conformance

quint run formal/dialcache-conformance.qnt \
  --mbt --backend=rust --n-threads=1 \
  --seed="${QUINT_SEED:-0xd1a1ca}" \
  --max-samples=256 --max-steps=30 --n-traces=32 \
  --out-itf='.formal-traces/conformance/trace_{seq}.itf.json' \
  --verbosity=1 \
  --invariants loaderCountsNonNegative redisCountsNonNegative readableRemoteHasValue

# An empty or partial corpus must fail generation, never look like conformance.
count=$(find .formal-traces/conformance -name '*.itf.json' -type f | wc -l)
if [ "${count}" -ne 32 ]; then
  echo "Expected 32 conformance traces; generated ${count}" >&2
  exit 1
fi

# Pending-effect traces share the portable behavioral driver. Keep profiles
# separate so each can evolve without a single combined state machine.
rm -rf .formal-traces/effects
mkdir -p .formal-traces/effects
quint run formal/dialcache-effects-conformance.qnt \
  --mbt --backend=rust --n-threads=1 \
  --seed="${QUINT_SEED:-0xd1a1ca}" \
  --max-samples=2048 --max-steps=60 --n-traces=256 \
  --out-itf='.formal-traces/effects/trace_{seq}.itf.json' \
  --verbosity=1 \
  --invariants oneRegisteredSource registeredFlightHasPendingCalls writeRequiresAcceptedSource registeredReadOwnsFlight effectCountsMatchRecords
count=$(find .formal-traces/effects -name '*.itf.json' -type f | wc -l)
if [ "${count}" -ne 256 ]; then
  echo "Expected 256 effects traces; generated ${count}" >&2
  exit 1
fi

generate_feature() {
  local profile="$1" traces="$2" samples="$3"
  shift 3
  local output=".formal-traces/features/${profile}"
  rm -rf "${output}"
  mkdir -p "${output}"
  quint run "formal/dialcache-${profile}-conformance.qnt" \
    --mbt --backend=rust --n-threads=1 --seed="${QUINT_SEED:-0xd1a1ca}" \
    --max-samples="${samples}" --max-steps=60 --n-traces="${traces}" \
    --out-itf="${output}/trace_{seq}.itf.json" --verbosity=1 --invariants "$@"
  local count
  count=$(find "${output}" -name '*.itf.json' -type f | wc -l)
  if [ "${count}" -ne "${traces}" ]; then
    echo "Expected ${traces} ${profile} traces; generated ${count}" >&2
    exit 1
  fi
}

generate_feature recovery 128 1024 singleReadPerFlight pendingDecodeHasCall writesHaveRetention sourcesMatchEffects onlyRegisteredSourceOwnsDeadline
generate_feature policy 256 1024 writesHaveRetention hitsSkipSource callsKeepSourceOutcome sourceCountsMatchEffects registeredSourcesArePending sharedSourcesKeepRegistration
# C1 failures/supersession require several independently controlled effects.
# Replay also requires these outcomes; trace count alone is insufficient.
generate_feature shadow 256 1024 oneSourcePerCaller writesRequireMiss writesHaveRetention
generate_feature scope 256 1024 closedScopesHaveNoMemo registeredSourcesArePending callsKeepSourceOutcome sourceCountsMatchEffects
generate_feature admission 128 1024 capacityIsPerInstance oneJobPerIdentity registeredCallsArePending callsKeepAcquiredValue jobsAreDiagnostic effectsMatchRecords
