import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// A boundary is always an exported regression. Keep the original profile
// directory: Go's single-file selector uses it to choose the driver.
export function boundaryTrace(history, traces = resolve('.formal-traces')) {
  const match = /^([a-z][a-z0-9-]*)\/([A-Za-z_]\w*)$/.exec(history);
  if (!match) throw new Error(`Invalid boundary history: ${history}`);
  return { profile: match[1], path: resolve(traces, 'regressions', `${history}.itf.json`) };
}

export function goBoundarySelection(profile, path) {
  const selections = {
    core: ['TestCoreConformance', 'DIALCACHE_MBT_TRACE_FILE'],
    effects: ['TestEffectsConformance', 'DIALCACHE_EFFECTS_TRACE_FILE'],
    'local-clock': ['TestLocalClockConformance', 'DIALCACHE_FEATURE_TRACE_FILE'],
  };
  const [test, selector] = selections[profile] ?? ['TestFeatureConformance', 'DIALCACHE_FEATURE_TRACE_FILE'];
  return { test, env: {
    // Core refuses file+directory selection; none of these targeted runs may
    // accidentally replay a cohort or require all of its action witnesses.
    DIALCACHE_MBT_TRACE_DIR: '', DIALCACHE_EFFECTS_TRACE_DIR: '', DIALCACHE_FEATURE_TRACE_DIR: '',
    DIALCACHE_MBT_TRACE_FILE: '', DIALCACHE_EFFECTS_TRACE_FILE: '', DIALCACHE_FEATURE_TRACE_FILE: '',
    DIALCACHE_FEATURE_PROFILE: '', [selector]: path,
  } };
}

function validRecording(record, path) {
  return record !== null && typeof record === 'object' && record.path === path
    && typeof record.completed === 'boolean' && Number.isSafeInteger(record.lastStep) && record.lastStep >= -1
    && (!record.completed || record.lastStep >= 1)
    && (record.error === undefined || typeof record.error === 'string')
    && Array.isArray(record.divergences) && record.divergences.every((item, index) => item !== null && typeof item === 'object'
      && Number.isSafeInteger(item.step) && item.step >= 0 && item.step <= record.lastStep
      && (index === 0 || item.step > record.divergences[index - 1].step)
      && typeof item.action === 'string' && Array.isArray(item.paths) && item.paths.length > 0
      && item.paths.every(path => typeof path === 'string' && path.length > 0));
}

// A recorded divergence is evidence only if the whole replay completed and
// its native process succeeded. Preserve partial observations and both errors
// for diagnosis, but never turn a missing recording or a failing cleanup into
// a confirmation merely because an earlier checkpoint diverged.
export function readBoundaryRecording(file, history, path, result) {
  const errors = [];
  let recording;
  try {
    const records = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (records.length !== 1 || !validRecording(records[0], path)) throw new Error('expected one valid recording of the selected history');
    recording = records[0];
  } catch (error) { errors.push(`recording unavailable: ${error.message}`); }
  if (recording?.error !== undefined) errors.push(recording.error || 'recording reported an unspecified error');
  if (result.error || result.signal || result.status !== 0) {
    errors.push(`boundary replay process failed: ${result.error?.message ?? result.error ?? result.signal ?? `exit ${result.status}`}`);
    // Go keeps the application failure outside the coordinator's discard
    // request. Retain that assertion line alongside the recorded failing step.
    const diagnostic = (result.stdout ?? '').split('\n').flatMap(line => {
      try { const event = JSON.parse(line); return typeof event.Output === 'string' ? event.Output.split('\n') : []; }
      catch { return []; }
    }).filter(line => /_test\.go:\d+:|panic:|fatal error:/.test(line)).join('\n');
    if (diagnostic) errors.push(diagnostic.slice(0, 8192));
  }
  return {
    history, via: 'coordinator', path,
    divergences: recording?.divergences ?? [],
    completed: recording?.completed === true && errors.length === 0,
    lastStep: recording?.lastStep ?? -1,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  };
}

// Boundary runs deliberately bypass the ordinary/generated/fixed cohort
// runners and their test-count comparisons. The same history may support
// several challenges, so callers run each history once and assess it against
// each challenge's own checkpoint afterward.
export function runBoundaryReplay({ port, history, label, output, root, workspace, env, go = 'go' }) {
  const { profile, path } = boundaryTrace(history, resolve(root, '.formal-traces'));
  const prefix = resolve(output, 'boundary', label, history);
  const file = `${prefix}.jsonl`;
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true });
  let command, args, cwd, selection;
  if (port === 'typescript') {
    command = process.execPath;
    args = [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', 'test/formal-boundary-evidence.test.ts', '--coverage.enabled=false'];
    cwd = workspace;
    selection = { DIALCACHE_BOUNDARY_HISTORY: history, DIALCACHE_BOUNDARY_OUT: file };
  } else if (port === 'go') {
    const selected = goBoundarySelection(profile, path);
    command = go;
    args = ['test', '-json', '-count=1', '-timeout=480s', '-run', `^${selected.test}$`, '.'];
    cwd = resolve(workspace, 'go');
    selection = { ...selected.env, DIALCACHE_REPLAY_DIVERGENCES: file };
  } else throw new Error(`Unknown boundary replay port: ${port}`);
  const result = spawnSync(command, args, {
    cwd, env: { ...env, ...selection }, encoding: 'utf8', timeout: 540_000, maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(`${prefix}.log`, (result.stdout ?? '') + (result.stderr ?? ''));
  const recording = readBoundaryRecording(file, history, path, result);
  if (recording.error) recording.error += `; see boundary/${label}/${history}.log`;
  writeFileSync(`${prefix}.json`, JSON.stringify(recording, null, 2) + '\n');
  return recording;
}

export function boundaryBaselines(evidence, replay) {
  const recordings = {};
  for (const history of new Set(evidence.flatMap(entry => entry.history ? [entry.history] : []))) {
    const recording = replay(history);
    recordings[history] = recording;
    if (!recording.completed || recording.divergences.length) {
      throw new Error(`Boundary baseline ${history} must complete with zero divergences: ${recording.error ?? JSON.stringify(recording.divergences)}`);
    }
  }
  return recordings;
}

export function mutationBoundaries(evidence, replay, assess) {
  const recordings = new Map();
  return evidence.map(entry => {
    if (entry.history && !recordings.has(entry.history)) recordings.set(entry.history, replay(entry.history));
    return assess(entry, recordings.get(entry.history));
  });
}
