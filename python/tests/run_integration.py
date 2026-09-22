"""Complete integration evidence from actual pytest collection and execution."""

from __future__ import annotations

import os
import sys
from collections import Counter
from pathlib import Path

# The acceptance lane owns its command and plugins, including configured addopts.
os.environ.pop("PYTEST_ADDOPTS", None)
os.environ.pop("PYTEST_PLUGINS", None)
os.environ["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"

import pytest


class Acceptance:
    def __init__(self):
        self.required = []
        self.selected = None
        self.reports = Counter()

    def pytest_itemcollected(self, item):
        if item.get_closest_marker("integration") is not None:
            self.required.append(item.nodeid)

    def pytest_collection_finish(self, session):
        self.selected = [item.nodeid for item in session.items]

    def pytest_runtest_logreport(self, report):
        self.reports[(report.nodeid, report.when, report.outcome, hasattr(report, "wasxfail"))] += 1

    def error(self):
        if not self.required:
            return "required integration inventory is empty"
        if len(self.required) != len(set(self.required)):
            return "required integration inventory contains duplicate node IDs"
        if Counter(self.selected or []) != Counter(self.required):
            return "selected cases do not equal the required integration inventory"
        expected = Counter(
            (nodeid, phase, "passed", False)
            for nodeid in self.required
            for phase in ("setup", "call", "teardown")
        )
        if self.reports != expected:
            return "required integration cases did not each pass setup, call and teardown exactly once"
        return None


root = Path(__file__).resolve().parents[2]
gate = Acceptance()
status = pytest.main(
    [
        "-c",
        str(root / "python/pyproject.toml"),
        "-o",
        "addopts=",
        "--noconftest",
        "-p",
        "pytest_asyncio.plugin",
        str(root / "python/tests/test_redis_integration.py"),
        str(root / "python/tests/test_docs_examples.py"),
        "-m",
        "integration",
        "-q",
        "--maxfail=1",
        f"--junitxml={sys.argv[1]}",
    ],
    plugins=[gate],
)
error = gate.error()
if error:
    print(f"Integration acceptance failed: {error}", file=sys.stderr)
sys.exit(int(status) or (1 if error else 0))
