"""Verify shared reachability evidence against the histories actually replayed.

The shared evaluator owns labels. This checker verifies its definition/corpus
fingerprints and provenance; it never substitutes reachability for native cache
observation assertions, which the runner must have completed first.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from .schema import ROOT, strict_json


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def check_witness(profile, cases, completed, directory=None):
    directory = Path(directory) if directory else ROOT / ".formal-traces/go-parity-witnesses"
    evidence = strict_json((directory / f"{profile}.json").read_text())
    selected = [case for case in cases if case.get("profile") == profile and case.get("path")]
    if not selected or any(case["id"] not in completed for case in selected):
        raise AssertionError(f"{profile} witness cannot credit an unexecuted native history")
    if (
        evidence.get("schemaVersion") != 2
        or evidence.get("profile") != profile
        or evidence.get("traces") != len(selected)
    ):
        raise AssertionError(f"Unsupported or incomplete {profile} witness evidence")
    required = strict_json((ROOT / "formal/coverage-witnesses.json").read_text())[profile]
    if not required or evidence.get("required") != required:
        raise AssertionError(f"{profile} required witness registry differs")
    seen = evidence.get("seen", [])
    if len(set(seen)) != len(seen) or not set(required).issubset(seen):
        raise AssertionError(f"{profile} missing or duplicate witnessed labels")
    actual = {}
    for case in selected:
        path = ROOT / case["path"]
        if path.name in actual:
            raise AssertionError(f"Duplicate witness history filename: {path.name}")
        result = completed[case["id"]]
        digest = sha256(path)
        if result["sha256"] != digest:
            raise AssertionError(f"History changed since native replay: {path}")
        actual[path.name] = (digest, case["category"], result["steps"])
    corpus = evidence.get("corpus", [])
    if len(corpus) != len(actual) or len({item["name"] for item in corpus}) != len(actual):
        raise AssertionError(f"Incomplete {profile} witness corpus fingerprints")
    for item in corpus:
        if item["name"] not in actual or item["sha256"] != actual[item["name"]][0]:
            raise AssertionError(f"Stale {profile} witness history: {item['name']}")
    for name in required:
        label = evidence.get("labels", {}).get(name)
        if not isinstance(label, dict) or not label.get("traces"):
            raise AssertionError(f"{profile} witness {name} lacks provenance")
        counts = {"sampled": 0, "regression": 0}
        cited = set()
        for trace in label["traces"]:
            record = actual.get(trace["name"])
            if record is None or trace["name"] in cited or trace["kind"] != record[1]:
                raise AssertionError(
                    f"{profile} witness {name} cites an unknown, duplicate or wrong-kind history"
                )
            cited.add(trace["name"])
            checkpoints = trace.get("checkpoints", [])
            if not checkpoints or any(
                type(index) is not int or index < 0 or index >= record[2] for index in checkpoints
            ):
                raise AssertionError(f"{profile} witness {name} has an invalid checkpoint")
            counts[record[1]] += 1
        if any(label.get(kind) != count for kind, count in counts.items()):
            raise AssertionError(f"{profile} witness {name} provenance counts differ")

    registry = strict_json((ROOT / "formal/profiles.json").read_text())
    execution = strict_json((ROOT / "formal/execution.json").read_text())
    models = {entry["path"] for entry in execution["models"]}
    libraries = sorted(
        str(path.relative_to(ROOT))
        for folder in (ROOT / "formal", ROOT / "formal/kernel")
        for path in folder.glob("*.qnt")
        if str(path.relative_to(ROOT)) not in models
    )
    replay = sorted(
        str(path.relative_to(ROOT))
        for path in (ROOT / "formal/replay").rglob("*")
        if path.is_file() and path.suffix in (".mjs", ".mts", ".json")
    )
    if registry["replaySources"] != replay:
        raise AssertionError("Shared replay source inventory differs from formal/replay")
    definition = next(entry for entry in registry["profiles"] if entry["id"] == profile)
    inputs = list(
        dict.fromkeys(
            [
                "formal/profiles.json",
                "formal/coverage-witnesses.json",
                "formal/execution.json",
                f"formal/dialcache-{profile}-conformance.qnt",
                "formal/conformance-observations.qnt",
                *libraries,
                *replay,
                *definition.get("witnessSources", []),
            ]
        )
    )
    expected = [{"path": path, "sha256": sha256(ROOT / path)} for path in inputs]
    if evidence.get("inputs") != expected:
        raise AssertionError(f"Stale or incomplete {profile} witness definition fingerprints")
