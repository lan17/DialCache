"""Persistent, checked JSONL transport to the authoritative shared coordinator."""

from __future__ import annotations

import json
import os
import select
import subprocess
from pathlib import Path

from .schema import ROOT, strict_json, validate


def node_binary():
    return os.environ.get("NODE", "node")


class Coordinator:
    def __init__(self):
        self.process = subprocess.Popen(
            [node_binary(), str(ROOT / "formal/replay/coordinator.mjs")],
            cwd=ROOT,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self.sequence = 0
        self.buffer = b""

    def request(self, **fields):
        self.sequence += 1
        request = {"version": 1, "id": self.sequence, **fields}
        validate(request, "request")
        self.process.stdin.write(json.dumps(request, separators=(",", ":"), allow_nan=False).encode() + b"\n")
        while b"\n" not in self.buffer:
            ready, _, _ = select.select([self.process.stdout], [], [], 30)
            if not ready:
                raise RuntimeError("Replay coordinator transport timeout")
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise RuntimeError(f"Replay coordinator exited: {self.process.stderr.read().decode()}")
            self.buffer += chunk
        line, self.buffer = self.buffer.split(b"\n", 1)
        response = strict_json(line)
        validate(response, "response")
        if response["version"] != 1 or response["id"] != self.sequence:
            raise RuntimeError("Mismatched coordinator response version or id")
        if not response["ok"]:
            raise AssertionError(response["error"])
        return response["result"]

    def replay(self, profile, path, *, settle=True):
        # Delayed imports allow schema and transport checks independently of the
        # implementation. Expected records remain exclusively in Node.
        from .driver import BehaviorDriver
        from .simple_drivers import CoreDriver, LocalClockDriver

        prepared = self.request(op="prepare", profile=profile, path=str(Path(path).resolve()))
        if prepared["settlement"] != "causally-ready-v1":
            raise RuntimeError("Unsupported replay settlement contract")
        driver = (
            CoreDriver()
            if profile == "core"
            else LocalClockDriver()
            if profile == "local-clock"
            else BehaviorDriver(prepared["fixture"], settle=settle)
        )
        complete = False
        try:
            for command in prepared["setup"]:
                driver.apply(command)
            index = 0
            while True:
                observation = driver.observe()
                validate(observation, prepared["observation"])
                receipt = driver.receipt()
                fields = {}
                if prepared["receipt"] is not None:
                    validate(receipt, prepared["receipt"])
                    fields["receipt"] = receipt
                elif receipt is not None:
                    raise RuntimeError("Unexpected native settlement receipt")
                result = self.request(
                    op="observe",
                    session=prepared["session"],
                    index=index,
                    settlement=prepared["settlement"],
                    observed=observation,
                    environment={"wallMs": driver.clock.wall_ms()},
                    **fields,
                )
                if result["complete"]:
                    complete = True
                    return result["steps"]
                if result["index"] != index + 1:
                    raise RuntimeError("Skipped coordinator observation index")
                index += 1
                for command in result["inputs"]:
                    driver.apply(command)
        finally:
            if not complete:
                try:
                    self.request(op="discard", session=prepared["session"])
                except (RuntimeError, AssertionError):
                    pass
            driver.close()

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdout.close()
        self.process.stderr.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
