"""Check the public decorator as a typed consumer, without checking engine internals."""

import os
import subprocess
import sys
from pathlib import Path


def test_cached_consumer_types(tmp_path):
    source_root = Path(__file__).resolve().parents[1]
    fixture = Path(__file__).with_name("typing") / "cached.py"
    environment = os.environ.copy()
    environment["MYPYPATH"] = os.pathsep.join(
        filter(None, [str(source_root), environment.get("MYPYPATH")])
    )
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "mypy",
            "--strict",
            "--follow-imports=silent",
            "--python-version=3.11",
            "--cache-dir",
            str(tmp_path / "mypy"),
            str(fixture),
        ],
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
