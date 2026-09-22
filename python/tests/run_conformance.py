#!/usr/bin/env python3
"""Replay shared histories with an explicit scope and per-case JSONL evidence.

--complete asserts every shared inventory case: generated histories, exported
regressions, fixed scenarios, wire vectors and corpus-bound witness evidence.
The prepared-context checker produces the final certificate. Native Redis
integration and mutation attribution remain separate validation obligations.
A selected subset can never claim completeness.
"""

from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from formal.coordinator import Coordinator, node_binary
from formal.schema import ROOT, strict_json

_worker_coordinator = None


def _start_worker():
    global _worker_coordinator
    _worker_coordinator = Coordinator()
    atexit.register(_worker_coordinator.close)


def _replay_case(case):
    """One actual native history in an isolated worker's persistent transport."""
    started = time.time_ns() // 1_000_000
    path = ROOT / case["path"]
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    try:
        count = _worker_coordinator.replay(case["profile"], path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise RuntimeError(f"History changed during native replay: {path}")
        status, message = "passed", None
    except Exception as error:
        count = 0
        status, message = "failed", str(error)
    return {
        "kind": "case",
        "id": case["id"],
        "status": status,
        "startedAt": started,
        "finishedAt": time.time_ns() // 1_000_000,
        "historySha256": digest,
        "steps": count,
        **({"message": message} if message else {}),
    }


def _replay_cases(cases, workers):
    if workers == 1:
        _start_worker()
        try:
            for case in cases:
                yield _replay_case(case)
        finally:
            atexit.unregister(_worker_coordinator.close)
            _worker_coordinator.close()
        return
    # No executor or cache is shared across workers. Every observation still
    # uses the same coordinator protocol and per-history settlement receipts.
    pool = ProcessPoolExecutor(max_workers=workers, initializer=_start_worker)
    try:
        futures = {pool.submit(_replay_case, case): case for case in cases}
        for future in as_completed(futures):
            yield future.result()
    finally:
        pool.shutdown(wait=True, cancel_futures=True)


def main():
    if not __debug__:
        raise RuntimeError(
            "Conformance assertions require normal Python execution; disable -O and PYTHONOPTIMIZE"
        )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--generated",
        action="store_true",
        help="All scheduled sampled histories and exported Quint regressions",
    )
    parser.add_argument(
        "--scenarios", action="store_true", help="Also replay the shared fixed behavioral scenarios"
    )
    parser.add_argument(
        "--complete",
        action="store_true",
        help="Execute every shared conformance inventory case; requires --report",
    )
    parser.add_argument("--profile", help="Restrict histories to one profile (partial evidence)")
    parser.add_argument("--trace", help="One explicit history; requires --profile")
    parser.add_argument("--report", help="Write native JSONL case evidence")
    parser.add_argument("--fail-fast", action="store_true")
    parser.add_argument(
        "--workers",
        type=int,
        default=min(4, os.cpu_count() or 1),
        help="Independent native replay processes (default: up to four)",
    )
    args = parser.parse_args()
    if args.workers < 1:
        parser.error("--workers must be positive")
    if args.complete:
        if args.profile or args.trace or not args.report:
            parser.error("--complete requires --report and cannot select a profile or trace")
        args.generated = args.scenarios = True
    profiles = json.loads((ROOT / "formal/profiles.json").read_text())["profiles"]
    known = {entry["id"] for entry in profiles}
    if args.profile and args.profile not in known:
        parser.error(f"Unknown profile {args.profile}")
    if args.trace and not args.profile:
        parser.error("--trace requires --profile")
    if args.trace and args.generated:
        parser.error("--trace conflicts with --generated")
    if args.trace:
        cases = [
            {
                "id": f"selected/{args.profile}/{Path(args.trace).name}",
                "profile": args.profile,
                "path": args.trace,
            }
        ]
    elif args.generated:
        # Inventory is owned by the shared execution manifest; no native copy of
        # trace counts, exported regression names or profile tables may drift.
        listing = subprocess.run(
            [node_binary(), "formal/conformance.mjs", "inventory"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=True,
        )
        inventory = strict_json(listing.stdout)
        cases = [case for case in inventory if case["category"] in ("sampled", "regression")]
    else:
        cases = [
            {"id": f"smoke/{entry['id']}", "profile": entry["id"], "path": entry["smoke"]}
            for entry in profiles
        ]
    if args.profile:
        cases = [case for case in cases if case["profile"] == args.profile]
    if not cases:
        raise RuntimeError("Empty Python replay selection")
    missing = [case["path"] for case in cases if not (ROOT / case["path"]).is_file()]
    if missing:
        raise RuntimeError(
            f"Incomplete scheduled replay corpus: {len(missing)} missing histories; first: {missing[0]}"
        )
    if args.generated and not args.profile:
        directories = {}
        for case in cases:
            path = ROOT / case["path"]
            directories.setdefault(path.parent, set()).add(path.name)
        for directory, expected in directories.items():
            actual = {path.name for path in directory.glob("*.itf.json")}
            if actual != expected:
                raise RuntimeError(f"Missing or extra scheduled histories in {directory}")
    report = open(args.report, "w") if args.report else None

    def emit(record):
        line = json.dumps(record, separators=(",", ":"), allow_nan=False)
        if report:
            report.write(line + "\n")
            report.flush()

    def now():
        return time.time_ns() // 1_000_000

    emit(
        {
            "kind": "start",
            "schemaVersion": 1,
            "implementation": "python",
            "scope": "conformance"
            if args.complete
            else "behavior-histories-and-scenarios"
            if args.scenarios
            else "behavior-histories",
            "selection": "generated" if args.generated else "smoke" if not args.trace else "selected",
            "partial": bool(args.profile or args.trace),
            "startedAt": now(),
        }
    )
    failed = 0
    executed = 0
    steps = 0
    completed = {}
    for record in _replay_cases(cases, args.workers):
        if record["status"] == "passed":
            steps += record["steps"]
            completed[record["id"]] = {"sha256": record["historySha256"], "steps": record["steps"]}
        else:
            failed += 1
            print(f"FAIL {record['id']}: {record['message']}", file=sys.stderr, flush=True)
        executed += 1
        emit(record)
        if executed % 50 == 0:
            print(
                f"Python replay: {executed}/{len(cases)} histories, {failed} failed",
                file=sys.stderr,
                flush=True,
            )
        if failed and args.fail_fast:
            break
    if args.scenarios and not (failed and args.fail_fast):
        from formal.scenarios import replay_scenario, scenarios

        for scenario in scenarios():

            def encode(text):
                return quote(text, safe="~()*!.'-")

            case_id = f"scenario/{encode(scenario['feature'])}/{encode(scenario['name'])}"
            started = now()
            try:
                replay_scenario(scenario)
                status, message = "passed", None
            except Exception as error:
                failed += 1
                status, message = "failed", str(error)
                print(f"FAIL {case_id}: {message}", file=sys.stderr, flush=True)
            executed += 1
            emit(
                {
                    "kind": "case",
                    "id": case_id,
                    "status": status,
                    "startedAt": started,
                    "finishedAt": now(),
                    **({"message": message} if message else {}),
                }
            )
            if failed and args.fail_fast:
                break
    if args.complete and not (failed and args.fail_fast):
        from formal.witness import check_witness
        from test_protocol_vectors import CORPORA, assert_wire_vector, test_schemas_provenance_and_inventory

        test_schemas_provenance_and_inventory()
        vectors = {}
        for corpus in CORPORA:
            for group, rows in corpus.items():
                if isinstance(rows, list):
                    for vector in rows:
                        key = (group, vector["name"])
                        if key in vectors:
                            raise RuntimeError(f"Duplicate wire vector {key}")
                        vectors[key] = vector
        protocol = [case for case in inventory if case["category"] == "protocol"]
        if set(vectors) != {(case["group"], case["name"]) for case in protocol}:
            raise RuntimeError("Native wire vectors differ from shared conformance inventory")
        for case in [*protocol, *(entry for entry in inventory if entry["category"] == "witness")]:
            started = now()
            try:
                if case["category"] == "protocol":
                    assert_wire_vector(case["group"], vectors[(case["group"], case["name"])])
                else:
                    check_witness(
                        case["profile"], cases, completed, os.getenv("DIALCACHE_WITNESS_EVIDENCE_DIR")
                    )
                status, message = "passed", None
            except Exception as error:
                failed += 1
                status, message = "failed", str(error)
                print(f"FAIL {case['id']}: {message}", file=sys.stderr, flush=True)
            executed += 1
            emit(
                {
                    "kind": "case",
                    "id": case["id"],
                    "status": status,
                    "startedAt": started,
                    "finishedAt": now(),
                    **({"message": message} if message else {}),
                }
            )
            if failed and args.fail_fast:
                break
    result = {
        "kind": "finish",
        "status": "failed" if failed else "passed",
        "cases": executed,
        "failed": failed,
        "steps": steps,
        "finishedAt": now(),
    }
    emit(result)
    print(json.dumps(result), flush=True)
    if report:
        report.close()
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
