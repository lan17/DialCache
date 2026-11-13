#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
output="${1:-${TMPDIR:-/tmp}/dialcache-scale-$(date -u +%Y%m%dT%H%M%SZ)}"
test -z "$(git status --porcelain)"
for command in cargo rustc timeout python3 sha256sum; do command -v "$command" > /dev/null; done
timeout --version | grep -q 'GNU coreutils'
mkdir -p "$(dirname "$output")"
mkdir -m 700 "$output"
output="$(cd "$output" && pwd)"
seconds="${DIALCACHE_SOAK_SECONDS:-10}"
[[ "$seconds" =~ ^[0-9]+$ ]] && (( seconds >= 6 && seconds <= 1800 ))
cases="${DIALCACHE_SOAK_CASES:-hot-hit spread-hit hot-miss spread-miss compressed tracked cancellation recovery}"
workers="${DIALCACHE_SOAK_WORKER_COUNTS:-1 2 4}"
rates="${DIALCACHE_SOAK_RATES:-1000}"
for case in $cases; do
  case "$case" in
    hot-hit|spread-hit|hot-miss|spread-miss|compressed|tracked|cancellation|recovery|malformed-small|malformed-large) ;;
    *) exit 2 ;;
  esac
  for worker in $workers; do
    [[ "$worker" =~ ^[124]$ ]]
    for rate in $rates; do
      [[ "$rate" =~ ^[0-9]+$ ]] && (( rate >= 1 && rate <= 20000 ))
      if [[ "$case" == malformed-* ]]; then (( rate <= 2 )); fi
      printf '%s-w%s-r%s\t%s\t%s\t%s\n' "$case" "$worker" "$rate" "$case" "$worker" "$rate"
    done
  done
done > "$output/inventory.tsv"
test -s "$output/inventory.tsv"
test -z "$(cut -f1 "$output/inventory.tsv" | sort | uniq -d)"

running=""
cleanup() {
  if [[ -n "$running" ]]; then
    kill -TERM -- "-$running" 2>/dev/null || true
    kill -TERM "$running" 2>/dev/null || true
    sleep 0.1
    kill -KILL -- "-$running" 2>/dev/null || true
    kill -KILL "$running" 2>/dev/null || true
    wait "$running" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

{
  git rev-parse HEAD HEAD^{tree}
  git status --short
  sha256sum rust/tests/scale_soak.rs scripts/rust-scale-soak.sh
  git ls-files -z rust/src rust/Cargo.toml rust/Cargo.lock rust/rust-toolchain.toml |
    sort -z | xargs -0 sha256sum | sha256sum
  rustc +1.98.1 --version
  uname -srmo
  for path in /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max; do
    if [[ -r "$path" ]]; then printf '%s ' "$path"; cat "$path"; fi
  done
} > "$output/inputs.txt"

cargo +1.98.1 test --manifest-path rust/Cargo.toml --locked --release \
  --test scale_soak --no-run --message-format=json > "$output/build.jsonl"
binary="$(python3 - "$output/build.jsonl" <<'PY'
import json
import sys
for line in open(sys.argv[1]):
    row = json.loads(line)
    if row.get("reason") == "compiler-artifact" and row.get("executable"):
        print(row["executable"])
PY
)"
test -x "$binary"
sha256sum "$binary" > "$output/binary.sha256"

while IFS=$'\t' read -r name case worker rate; do
  printf 'Running %s for %s seconds\n' "$name" "$seconds"
  DIALCACHE_SOAK_CASE="$case" DIALCACHE_SOAK_WORKERS="$worker" \
    DIALCACHE_SOAK_RATE="$rate" DIALCACHE_SOAK_SECONDS="$seconds" \
    timeout --signal=TERM --kill-after=5 "$((seconds + 20))" \
    bash -c 'ulimit -v 4194304; ulimit -t "$1"; exec "$2" bounded_offered_load_drains_all_work --ignored --nocapture --test-threads=1' \
    bash "$((seconds * 4 + 30))" "$binary" > "$output/$name.log" 2>&1 &
  running="$!"
  wait "$running"
  running=""
done < "$output/inventory.tsv"

python3 - "$output" <<'PY' | tee "$output/summary.jsonl"
import json
import pathlib
import sys
output = pathlib.Path(sys.argv[1])
inventory = [line.split("\t")[0] for line in (output / "inventory.tsv").read_text().splitlines()]
assert {path.stem for path in output.glob("*.log")} == set(inventory)
binary_sha256 = (output / "binary.sha256").read_text().split()[0]
source_commit = (output / "inputs.txt").read_text().splitlines()[0]
for name in inventory:
    path = output / f"{name}.log"
    rows = []
    for line in path.read_text().splitlines():
        start = line.find("{")
        if start >= 0:
            try:
                rows.append(json.loads(line[start:]))
            except json.JSONDecodeError:
                pass
    settings = next(row for row in rows if row["phase"] == "settings")
    close = next(row for row in rows if row["phase"] == "admission_closed")
    drain = next(row for row in rows if row["phase"] == "drained")
    end = next(row for row in rows if row["phase"] == "runtime_dropped")
    metrics = drain["metrics"]
    rss = [row["metrics"]["rss_kib"] for row in rows if row.get("metrics", {}).get("rss_kib") is not None]
    print(json.dumps({
        "case": path.stem, "seconds": settings["seconds"], "settings": settings,
        "source_commit": source_commit, "binary_sha256": binary_sha256,
        "offered": metrics["offered"], "admitted": metrics["admitted"],
        "completed_within_window": metrics["completed_within_window"],
        "completed_per_second_within_window": metrics["completed_within_window"] / settings["seconds"],
        "successful_within_window": metrics["successful_within_window"],
        "successful_per_second_within_window": metrics["successful_within_window"] / settings["seconds"],
        "eventual_success_per_offered": metrics["logical_ok"] / metrics["offered"],
        "scheduler_late": metrics["scheduler_late"], "window_closed": metrics["window_closed"],
        "admission_rejected": metrics["admission_rejected"],
        "logical_errors": metrics["logical_error"], "logical_deadlines": metrics["logical_deadline"],
        "attempts": metrics["attempts"], "caller_timeouts": metrics["caller_timeout"],
        "source_peak": metrics["source"]["peak"], "provider_peak": metrics["provider"]["peak"],
        "detached_peak": metrics["detached"]["peak"], "cpu_running_peak": metrics["cpu_running"]["peak"],
        "cpu_rejected": metrics["cpu_rejected"], "read_over_limit": metrics["read_over_limit"],
        "recovered": metrics["recovered"], "fenced": metrics["fenced"],
        "all_terminal_latency": metrics["latency"], "success_latency": metrics["success_latency"],
        "sampled_rss_min_kib": min(rss) if rss else None, "sampled_rss_max_kib": max(rss) if rss else None,
        "post_runtime_rss_kib": end["metrics"]["rss_kib"],
        "drain_after_admission_ms": drain["elapsed_ms"] - close["elapsed_ms"],
        "all_tracked_work_drained": all(end["metrics"][key]["active"] == 0 for key in
            ["source", "provider", "callers", "detached", "cpu_outstanding", "cpu_running", "remote"]),
        "sampled_values_live_after_runtime": end["metrics"]["sampled_values_live"],
    }))
PY
printf 'Evidence: %s\n' "$output"
