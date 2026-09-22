"""Replay the shared fixed supplement, keeping expectations outside drivers."""

import copy
import json

from .driver import BehaviorDriver, empty_observation
from .schema import ROOT, json_equal, strict_json, validate


def scenarios():
    corpus = strict_json((ROOT / "formal/behavioral-scenarios.json").read_text())
    if corpus["schemaVersion"] != 2 or not corpus["scenarios"]:
        raise RuntimeError("Unsupported or empty behavioral scenario corpus")
    names = [item["name"] for item in corpus["scenarios"]]
    if len(set(names)) != len(names):
        raise RuntimeError("Duplicate behavioral scenario name")
    return corpus["scenarios"]


def replay_scenario(scenario):
    fixture = scenario["fixture"]
    validate(fixture, "behaviorFixture")
    driver = BehaviorDriver(fixture)
    expected = empty_observation(fixture)
    try:
        for index, step in enumerate(scenario["steps"]):
            unknown = set(step["expect"]) - set(expected)
            if unknown:
                raise RuntimeError(f"Unknown scenario expectation fields: {unknown}")
            expected.update(copy.deepcopy(step["expect"]))
            validate(step["input"], "command")
            driver.apply(step["input"])
            actual = driver.observe()
            validate(actual, "behaviorObservation")
            if driver.receipt()["runnable"]:
                raise RuntimeError("Settlement violation: runnable task(s) at observation")
            if not json_equal(actual, expected):
                raise AssertionError(
                    f"{scenario['name']} step {index} input {step['input']}\nexpected: {json.dumps(expected)}\nactual: {json.dumps(actual)}"
                )
    finally:
        driver.close()
