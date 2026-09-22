"""Native validation must import the selected checkout with any prepared interpreter."""

from __future__ import annotations

import json
import os
import shutil
import site
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
VALIDATION = ROOT / "formal/validation.mjs"
NODE_BRIDGE = r"""
import { pathToFileURL } from 'node:url';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const { module, directory, environment, boundary } = JSON.parse(input);
const { checkPrerequisites, validationPlan, executeSteps } = await import(pathToFileURL(module));
if (boundary === 'prerequisites') {
  checkPrerequisites('check-python', { directory, environment });
} else {
  const steps = validationPlan(boundary, { directory, environment })
    .filter(step => step.command === environment.PYTHON);
  if (steps.length === 0) throw new Error('Expected direct Python validation steps');
  await executeSteps(steps, { directory, environment });
}
"""
NATIVE_TEST = """
from pathlib import Path
import dialcache
import validation_caller_marker

def test_selected_checkout_import():
    assert Path(dialcache.__file__).resolve() == (Path.cwd() / 'python/dialcache/__init__.py').resolve()
    assert dialcache.DialCache.__module__ == 'dialcache.cache'
    assert validation_caller_marker.VALUE == 'caller path retained'
"""


@pytest.mark.parametrize("boundary", ["check-python", "smoke", "prerequisites"])
def test_validation_selects_checkout_over_foreign_editable(tmp_path, boundary):
    node = os.environ.get("NODE") or shutil.which("node")
    assert node is not None, "Node 24 is required by Python validation"
    checkout = tmp_path / "selected-checkout"
    tests = checkout / "python/tests"
    tests.mkdir(parents=True)
    shutil.copytree(
        ROOT / "python/dialcache", checkout / "python/dialcache", ignore=shutil.ignore_patterns("__pycache__")
    )
    (tests / "test_conformance.py").write_text(NATIVE_TEST)
    shutil.copyfile(ROOT / "python/pyproject.toml", checkout / "python/pyproject.toml")
    # Both generated native commands run their exact argv, but this small
    # checkout contains only the sentinel test, so this test cannot recurse.
    foreign = tmp_path / "foreign-editable"
    (foreign / "dialcache").mkdir(parents=True)
    (foreign / "dialcache/__init__.py").write_text(
        "raise RuntimeError('foreign editable dialcache was imported')\n"
    )
    env_dir = tmp_path / "venv"
    # venv uses this test process's sys.executable; no pip or network is needed.
    subprocess.run(
        [sys.executable, "-m", "venv", "--without-pip", str(env_dir)],
        check=True,
        capture_output=True,
        text=True,
    )
    python = env_dir / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    library = Path(
        subprocess.check_output(
            [str(python), "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], text=True
        ).strip()
    )
    # Reuse installed dependencies without processing the source environment's
    # editable-install .pth. The foreign package is the only editable on sys.path.
    (library / "probe.pth").write_text("\n".join([str(foreign), *site.getsitepackages()]) + "\n")
    inherited = tmp_path / "caller-path"
    inherited.mkdir()
    (inherited / "validation_caller_marker.py").write_text("VALUE = 'caller path retained'\n")
    environment = {
        **os.environ,
        "PYTHON": str(python),
        "PYTHONPATH": os.pathsep.join([str(foreign), str(inherited)]),
        "PYTEST_DISABLE_PLUGIN_AUTOLOAD": "1",
        "PYTEST_ADDOPTS": "",
    }
    # Prove this interpreter really imports the foreign package absent the fix.
    control_env = {key: value for key, value in environment.items() if key != "PYTHONPATH"}
    control = subprocess.run(
        [str(python), "-c", "import dialcache"], cwd=checkout, env=control_env, text=True, capture_output=True
    )
    assert control.returncode != 0 and "foreign editable dialcache was imported" in control.stderr
    # Satisfy unrelated Node/package-manager prerequisites without installations.
    if boundary == "prerequisites":
        (checkout / "node_modules/typescript").mkdir(parents=True)
        (checkout / "node_modules/typescript/package.json").write_text("{}")
        package = json.loads((ROOT / "package.json").read_text())
        (checkout / "package.json").write_text(json.dumps({"packageManager": package["packageManager"]}))
        tools = tmp_path / "bin"
        tools.mkdir()
        corepack = tools / "corepack"
        corepack.write_text(
            f"#!{node}\nconsole.log({json.dumps(package['packageManager'].removeprefix('pnpm@'))});\n"
        )
        corepack.chmod(0o755)
        environment["PATH"] = str(tools) + os.pathsep + environment.get("PATH", "")
    result = subprocess.run(
        [node, "--input-type=module", "-e", NODE_BRIDGE],
        cwd=ROOT,
        env=environment,
        input=json.dumps(
            {
                "module": str(VALIDATION),
                "directory": str(checkout),
                "environment": environment,
                "boundary": boundary,
            }
        ),
        text=True,
        capture_output=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    if boundary == "check-python":
        report = (checkout / "coverage/python/native.lcov").read_text()
        sources = [line.removeprefix("SF:") for line in report.splitlines() if line.startswith("SF:")]
        assert "python/dialcache/cache.py" in sources
        assert all(
            source.startswith("python/dialcache/") and (checkout / source).is_file() for source in sources
        )
