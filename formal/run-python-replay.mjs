// Python behavior replay deliberately uses the existing coordinator and corpus.
// Node is a test-tool dependency; the Python runtime package never invokes it.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.PYTHON ?? resolve(root, 'python/.venv/bin/python');
const result = spawnSync(python, [resolve(root, 'python/tests/run_conformance.py'), ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NODE: process.execPath },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
