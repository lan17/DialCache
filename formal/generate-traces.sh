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
  --max-samples=256 --max-steps=40 --n-traces=32 \
  --out-itf='.formal-traces/effects/trace_{seq}.itf.json' \
  --verbosity=1 \
  --invariants oneRegisteredSource registeredFlightHasPendingCalls writeRequiresAcceptedSource
count=$(find .formal-traces/effects -name '*.itf.json' -type f | wc -l)
if [ "${count}" -ne 32 ]; then
  echo "Expected 32 effects traces; generated ${count}" >&2
  exit 1
fi
