"""Smoke histories, fixed scenarios and the no-settle infrastructure control."""

import json
import os
import subprocess
import sys

import pytest
from formal.coordinator import Coordinator, node_binary
from formal.scenarios import replay_scenario, scenarios
from formal.schema import ROOT, json_equal, strict_json, validate

PROFILES = json.loads((ROOT / "formal/profiles.json").read_text())["profiles"]
SELECTED = [
    entry
    for entry in PROFILES
    if not os.getenv("DIALCACHE_PYTHON_PROFILE") or entry["id"] == os.environ["DIALCACHE_PYTHON_PROFILE"]
]


@pytest.fixture(scope="module")
def coordinator():
    with Coordinator() as value:
        yield value


@pytest.mark.parametrize("profile", SELECTED, ids=lambda item: item["id"])
def test_profile_smoke(coordinator, profile):
    assert coordinator.replay(profile["id"], ROOT / profile["smoke"]) > 0


@pytest.mark.parametrize(
    "profile",
    [entry for entry in SELECTED if entry["id"] not in ("core", "local-clock")],
    ids=lambda item: item["id"],
)
def test_no_settle_control(coordinator, profile):
    # Skipping settlement must be diagnosed as infrastructure failure before
    # comparing observations, never as evidence of a behavioral divergence.
    with pytest.raises(AssertionError, match="Settlement violation") as error:
        coordinator.replay(profile["id"], ROOT / profile["smoke"], settle=False)
    assert "Observation mismatch" not in str(error.value)


@pytest.mark.parametrize("scenario", scenarios(), ids=lambda item: item["name"])
def test_shared_scenario(scenario):
    replay_scenario(scenario)


def test_executor_drains_complete_causal_work_without_advancing_time():
    from formal.executor import Executor

    executor = Executor()
    observed = []
    held = executor.future()

    def ready(index):
        observed.append(index)
        if index < 1024:
            executor.loop.call_soon(ready, index + 1)

    async def parked():
        await held
        observed.append("released")

    try:
        executor.task(parked())
        executor.loop.call_soon(ready, 0)
        executor.clock.call_later(1, lambda: observed.append("timer"))
        executor.drain()
        assert observed == list(range(1025))
        assert executor.clock.monotonic_ms() == 0
        assert not held.done()
        assert executor.drain() == 0
        held.set_result(None)
        executor.drain()
        assert observed[-1] == "released"
        executor.clock.advance(1)
        assert observed[-1] == "timer"
    finally:
        executor.close()


def test_silent_clock_advance_keeps_timer_delivery_held():
    from formal.executor import Executor

    executor = Executor()
    fired = []
    try:
        executor.clock.call_later(5, lambda: fired.append(executor.clock.monotonic_ms()))
        executor.clock.advance(10, deliver=False)
        executor.drain()
        assert fired == []
        assert executor.clock.monotonic_ms() == 10
        executor.clock.advance(5)
        assert fired == [15]
    finally:
        executor.close()


def test_protocol_rejects_non_json_and_boolean_integer_confusion():
    with pytest.raises(ValueError, match="Duplicate JSON"):
        strict_json('{"id": 1, "id": 2}')
    with pytest.raises(ValueError, match="Non-JSON"):
        strict_json('{"x": NaN}')
    with pytest.raises(RuntimeError, match="Malformed native replay request"):
        validate({"version": 1, "id": True, "op": "profiles"}, "request")
    assert not json_equal({"calls": [True]}, {"calls": [1]})
    assert json_equal({"calls": [1.0]}, {"calls": [1]})


def test_persistent_transport_rejects_duplicate_ids():
    with Coordinator() as coordinator:
        coordinator.request(op="profiles")
        coordinator.sequence -= 1
        with pytest.raises(AssertionError, match="Duplicate or out-of-order replay request"):
            coordinator.request(op="profiles")


def test_transport_rejects_mismatched_response_id(monkeypatch):
    import formal.coordinator as transport

    real_popen = subprocess.Popen
    program = "import json,sys\nfor line in sys.stdin:\n r=json.loads(line); print(json.dumps({'version':1,'id':r['id']+1,'ok':False,'error':'controlled'}),flush=True)"
    monkeypatch.setattr(
        transport.subprocess,
        "Popen",
        lambda command, **options: real_popen([sys.executable, "-u", "-c", program], **options),
    )
    with Coordinator() as coordinator:
        with pytest.raises(RuntimeError, match="Mismatched coordinator response"):
            coordinator.request(op="profiles")


def test_complete_report_gate_requires_every_native_assertion():
    # These synthetic records challenge only the report parser; none are saved
    # or presented as implementation evidence.
    program = r"""
      import assert from 'node:assert/strict';
      import { checkPythonReplay } from './formal/check-python-replay.mjs';
      const inventory = ['sampled','regression','scenario','protocol','witness'].map(category => ({id: `${category}/example`, category}));
      const make = () => [
        {kind:'start',schemaVersion:1,implementation:'python',scope:'conformance',selection:'generated',partial:false,startedAt:1},
        ...inventory.map(entry => ({kind:'case',id:entry.id,status:'passed',startedAt:2,finishedAt:3})),
        {kind:'finish',status:'passed',cases:5,failed:0,finishedAt:4},
      ];
      const check = records => checkPythonReplay(records.map(x => JSON.stringify(x)).join('\n'), inventory);
      assert.equal(check(make()).executedCases,5);
      for (let index=1; index<=5; index++) {
        const missing=make(); missing.splice(index,1); missing.at(-1).cases--;
        assert.throws(() => check(missing),/Missing passed/);
      }
      for (const status of ['failed','skipped','running']) {
        const report=make(); report[1].status=status;
        assert.throws(() => check(report),/failed or skipped/);
      }
      const duplicate=make(); duplicate[2]=duplicate[1]; assert.throws(() => check(duplicate),/Duplicate/);
      const countOnly=[make()[0],make().at(-1)]; assert.throws(() => check(countOnly),/Incomplete/);
      for (const field of [{scope:'behavior-histories'},{selection:'smoke'},{partial:true}]) {
        const report=make(); Object.assign(report[0],field); assert.throws(() => check(report),/not a complete/);
      }
      const incomplete=make(); incomplete.pop(); assert.throws(() => check(incomplete),/missing finish/);
      const unknown=make(); unknown[1].id='unknown'; assert.throws(() => check(unknown),/Unknown/);
      const withPath=inventory.map((entry,index) => index===0 ? {...entry,path:'trace.itf.json'} : entry);
      const bound=make(); bound[1].historySha256='a'.repeat(64);
      const serialized=bound.map(x=>JSON.stringify(x)).join('\n');
      assert.throws(() => checkPythonReplay(serialized,withPath,{corpus:{'trace.itf.json':'b'.repeat(64)}}),/fingerprint differs/);
      assert.equal(checkPythonReplay(serialized,withPath,{corpus:{'trace.itf.json':'a'.repeat(64)}}).executedCases,5);
    """
    subprocess.run(
        [node_binary(), "--input-type=module", "-e", program],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )


def test_complete_runner_refuses_stripped_python_assertions(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            "-O",
            str(ROOT / "python/tests/run_conformance.py"),
            "--complete",
            "--report",
            str(tmp_path / "replay.jsonl"),
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "disable -O and PYTHONOPTIMIZE" in result.stderr
    assert not (tmp_path / "replay.jsonl").exists()
