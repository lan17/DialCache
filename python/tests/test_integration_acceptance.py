"""The real integration coordinator must require all assertions on its labeled backend."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]

TEST = """
from pathlib import Path
import os
import pytest
pytestmark = pytest.mark.integration
{plugins}

def test_inventory_only():
    pass

@pytest.mark.parametrize("value", ["雪", "<not-xml>"])
def test_required(value):
    mode = os.environ.get("PROBE_MODE")
    if mode == "skip":
        pytest.skip("must not earn acceptance")
    if mode == "fail":
        assert False, "sentinel required assertion"
    with open(os.environ["PROBE_LOG"], "a") as output:
        output.write(os.environ["TEST_REDIS_URL"] + " " + value + "\\n")
"""
DOCS = """
import os
import pytest
def test_request_scope():
    assert False, "unmarked docs example was incorrectly selected"
def test_runtime_policy():
    assert False, "unmarked docs example was incorrectly selected"
@pytest.mark.integration
def test_tracked_invalidation():
    assert os.environ["DOCS_REDIS_URL"] == os.environ["TEST_REDIS_URL"]
"""
PLUGIN = """
import os
import pytest
@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(session, config, items):
    mode = os.environ.get("PROBE_MODE")
    if mode == "subset":
        items[:] = [item for item in items if "inventory_only" in item.nodeid]
    elif mode == "exclude_mixed_client":
        items[:] = [item for item in items if "test_wire_interop.py" not in item.nodeid]
    elif mode == "duplicate":
        items.append(next(item for item in items if item.get_closest_marker("integration")))
    elif mode == "empty":
        items[:] = []
    elif mode == "xpass":
        for item in items:
            item.add_marker(pytest.mark.xfail(reason="unexpected passes do not earn acceptance"))
def pytest_runtestloop(session):
    if os.environ.get("PROBE_MODE") == "no_reports":
        return True
"""


CHALLENGES = [
    "baseline",
    "inherited_keyword",
    "configured_keyword",
    "inherited_collect_only",
    "external_plugin_ignored",
    "subset",
    "exclude_mixed_client",
    "duplicate",
    "empty",
    "skip",
    "fail",
    "xpass",
    "no_reports",
]


@pytest.mark.parametrize(
    "suite,challenge",
    [
        (suite, challenge)
        for suite in ["native", "wire"]
        for challenge in CHALLENGES
        if suite == "wire" or challenge != "exclude_mixed_client"
    ],
)
def test_integration_coordinator_requires_complete_cases_on_each_backend(tmp_path, suite, challenge):
    node = os.environ.get("NODE") or shutil.which("node")
    assert node, "Node 24 is required by Python validation"
    checkout = tmp_path
    (checkout / "formal").mkdir()
    tests = checkout / "python/tests"
    tests.mkdir(parents=True)
    shutil.copyfile(
        ROOT / "formal/run-python-integration.mjs", checkout / "formal/run-python-integration.mjs"
    )
    shutil.copyfile(ROOT / "python/tests/run_integration.py", tests / "run_integration.py")
    configured = "-k test_inventory_only" if challenge == "configured_keyword" else ""
    (checkout / "python/pyproject.toml").write_text(
        '[tool.pytest.ini_options]\nasyncio_mode="auto"\n'
        'markers=["integration: required real-server case"]\n'
        f"addopts={json.dumps(configured)}\n"
    )
    failures = {"subset", "exclude_mixed_client", "duplicate", "empty", "skip", "fail", "xpass", "no_reports"}
    mode = challenge if challenge in failures else "pass"
    external_plugin = challenge == "external_plugin_ignored"
    if external_plugin:
        mode = "subset"
    (tests / "test_redis_integration.py").write_text(
        TEST.format(plugins='pytest_plugins = ["challenge_plugin"]' if challenge in failures else "")
    )
    (tests / "test_docs_examples.py").write_text(DOCS)
    (checkout / "interop").mkdir()
    (checkout / "interop/test_wire_interop.py").write_text(
        TEST.format(plugins='pytest_plugins = ["challenge_plugin"]' if challenge in failures else "")
        .replace('"雪"', '"wire雪"')
        .replace('"<not-xml>"', '"wire<not-xml>"')
    )
    (tests / "challenge_plugin.py").write_text(PLUGIN)
    coverage = checkout / "coverage/python"
    coverage.mkdir(parents=True)
    for backend in ["Redis", "Valkey"]:
        (coverage / f"{backend}.lcov").write_text("stale report must not survive a failed run")
    log = checkout / "executed.txt"
    addopts = "-k test_inventory_only" if challenge == "inherited_keyword" else ""
    if challenge == "inherited_collect_only":
        addopts = "--collect-only"
    environment = {
        **os.environ,
        "PYTHON": sys.executable,
        "NODE": node,
        "PYTHONPATH": str(tests),
        "TEST_REDIS_URL": "redis://127.0.0.1:9",
        "TEST_VALKEY_URL": "redis://127.0.0.1:19",
        "TEST_REDIS_CLUSTER_URL": "redis://127.0.0.1:29",
        "DOCS_REDIS_URL": "redis://127.0.0.1:39",
        "PROBE_MODE": mode,
        "PROBE_LOG": str(log),
        "PYTEST_ADDOPTS": addopts,
        "PYTEST_PLUGINS": "challenge_plugin" if external_plugin else "",
    }
    result = subprocess.run(
        [node, "formal/run-python-integration.mjs", "--suite", suite],
        cwd=checkout,
        env=environment,
        text=True,
        capture_output=True,
        timeout=30,
    )
    if challenge in failures:
        assert result.returncode != 0, result.stdout + result.stderr
        assert "Integration acceptance failed:" in result.stderr, result.stdout + result.stderr
        if suite == "native":
            assert not list(coverage.glob("*.lcov"))
    else:
        assert result.returncode == 0, result.stdout + result.stderr
        for backend in ["Redis", "Valkey"]:
            if suite == "native":
                report = (coverage / f"{backend}.lcov").read_text()
                assert "SF:" in report and "stale report" not in report
            else:
                assert (checkout / f".formal-traces/wire-integration-{backend}.xml").is_file()
        assert log.read_text().splitlines() == [
            f"{url} {value}"
            for url in [environment["TEST_REDIS_URL"], environment["TEST_VALKEY_URL"]]
            for value in (["雪", "<not-xml>"] if suite == "native" else ["wire雪", "wire<not-xml>"])
        ]
    if suite == "wire":
        # Wire evidence must not replace or clear native Python Codecov data.
        for backend in ["Redis", "Valkey"]:
            assert (coverage / f"{backend}.lcov").read_text() == "stale report must not survive a failed run"
