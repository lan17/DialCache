import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assessVectorBoundary, validVectorResult } from './vector-evidence.mjs';

export function runVectorBoundary({ evidence, port, history, label, output, root, workspace, env, go = 'go' }) {
  const sample = evidence.vector.samples[port];
  if (!sample) throw new Error(`Unknown vector binding: ${port}`);
  const prefix = resolve(output, 'boundary', label, history);
  mkdirSync(dirname(prefix), { recursive: true });
  const request = `${prefix}.request.json`, out = `${prefix}.native.json`;
  writeFileSync(request, JSON.stringify(sample.request) + '\n');
  rmSync(out, { force: true });
  const selected = { ...env, DIALCACHE_VECTOR_REQUEST: request, DIALCACHE_VECTOR_OUT: out };
  const result = port === 'typescript'
    ? spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', 'test/formal-vector-boundary.test.ts', '--coverage.enabled=false'],
      { cwd: resolve(workspace, 'typescript'), env: selected, encoding: 'utf8', timeout: 120_000 })
    : spawnSync(go, ['test', '-count=1', '-timeout=60s', '-run', '^TestVectorBoundaryDriver$', './internal/dialcache'],
      { cwd: resolve(workspace, 'go'), env: selected, encoding: 'utf8', timeout: 120_000 });
  writeFileSync(`${prefix}.log`, (result.stdout ?? '') + (result.stderr ?? ''));
  const recording = { history, path: evidence.vector.artifact, via: 'vector', completed: false, lastStep: -1, divergences: [] };
  try {
    if (result.error || result.signal || result.status !== 0) throw new Error(`Native vector process failed: ${result.error?.message ?? result.signal ?? result.status}`);
    const native = JSON.parse(readFileSync(out, 'utf8'));
    if (!native || Object.keys(native).join() !== 'actual' || !validVectorResult(sample.request.operation, native.actual)) throw new Error('Missing or malformed native vector output');
    Object.assign(recording, { completed: true, lastStep: 0, vectorResult: {
      history, port, row: sample.row, artifactSha256: evidence.vector.artifactSha256, inputSha256: sample.inputSha256, actual: native.actual,
    } });
    const assessed = assessVectorBoundary(evidence, recording);
    if (assessed.state === 'unreached') throw new Error(assessed.reason);
    recording.divergences = assessed.divergences;
  } catch (error) {
    recording.completed = false;
    recording.error = `${error.message}; see boundary/${label}/${history}.log`;
  }
  writeFileSync(`${prefix}.json`, JSON.stringify(recording, null, 2) + '\n');
  return recording;
}
