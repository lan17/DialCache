import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';

// Process-level concurrency for the formal scripts that spawn Quint.
//
// Rules shared by run-models.mjs, check-model-properties.mjs and
// generated-fixtures.mjs:
// - Every Quint process keeps the manifest's `--n-threads=1`. Parallelism comes
//   only from running independent processes side by side; each process owns its
//   seed, inputs and output paths, so a result never depends on the worker count.
// - Worker count: QUINT_JOBS when set (a positive integer), otherwise
//   os.availableParallelism() capped at one worker per 2 GiB of memory, never
//   below one. The Quint CLI holds a whole trace corpus before writing it, so a
//   1024-trace generation process peaks near 1.7 GiB; a core count alone would
//   over-commit memory on a many-core laptop. QUINT_JOBS=1 is the sequential path.
// - runPool returns results indexed by task, not by finish time, so a report
//   assembled from them is deterministic.
// - A command's stdout and stderr are buffered and printed as one `::group::`
//   block when the command finishes, so GitHub log groups never interleave.
// - Fail fast: after the first failed task no further task starts; tasks already
//   in flight run to completion (they are never killed) and still print their
//   groups; the pool then rethrows the first failure.
export const memoryPerWorker = 2 * 2 ** 30;
export function resolveConcurrency(env = process.env, available = availableParallelism(), memory = totalmem()) {
  const raw = env.QUINT_JOBS;
  if (raw === undefined) return Math.max(1, Math.min(available, Math.floor(memory / memoryPerWorker)));
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`QUINT_JOBS must be a positive integer; got ${JSON.stringify(raw)}`);
  }
  return value;
}

// Nonzero exit or signal from a spawned command. `status` lets a CLI exit with
// the child's own code, as the sequential spawnSync loops did.
export class CommandFailure extends Error {
  constructor(message, { status, signal } = {}) {
    super(message);
    this.name = 'CommandFailure';
    this.status = status;
    this.signal = signal;
  }
}

// Quint calls process.exit after printing failed tests. Its piped output can
// lose buffered diagnostics at that exit; regular files make Node's writes
// synchronous. Read both streams only after close, then remove the private files.
// Failures (including capture failures) stay in `error`, never property evidence.
export async function spawnBuffered(command, args, { cwd, env, timeoutMs } = {}) {
  const started = performance.now();
  const result = { status: null, signal: null, error: undefined, stdout: '', stderr: '', durationMs: 0 };
  const descriptors = [];
  let directory;
  try {
    directory = mkdtempSync(join(tmpdir(), 'dialcache-quint-output-'));
    const paths = ['stdout', 'stderr'].map(name => join(directory, name));
    for (const path of paths) descriptors.push(openSync(path, 'wx'));
    await new Promise(settle => {
      const child = spawn(command, args, { cwd, env, stdio: ['ignore', ...descriptors] });
      let timer;
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          result.error ??= Object.assign(new Error(`Timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' });
          child.kill('SIGTERM');
        }, timeoutMs);
      }
      child.once('error', cause => { result.error ??= cause; });
      child.once('close', (status, signal) => {
        clearTimeout(timer);
        Object.assign(result, { status, signal });
        settle();
      });
    });
    [result.stdout, result.stderr] = paths.map(path => readFileSync(path, 'utf8'));
  } catch (error) {
    result.error ??= error;
  } finally {
    for (const descriptor of descriptors) {
      try { closeSync(descriptor); } catch (error) { result.error ??= error; }
    }
    if (directory) {
      try { rmSync(directory, { recursive: true, force: true }); } catch (error) { result.error ??= error; }
    }
    result.durationMs = performance.now() - started;
  }
  return result;
}

export function formatGroup(title, ...texts) {
  const body = texts.filter(Boolean).join('');
  return `::group::${title}\n${body}${body && !body.endsWith('\n') ? '\n' : ''}::endgroup::`;
}
export const printGroup = (title, ...texts) => console.log(formatGroup(title, ...texts));
export const seconds = durationMs => `${(durationMs / 1000).toFixed(1)} s`;

// Execute async task thunks with at most `concurrency` in flight.
export async function runPool(tasks, { concurrency = resolveConcurrency() } = {}) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error(`Invalid pool concurrency: ${concurrency}`);
  const results = new Array(tasks.length);
  let next = 0, failure;
  const worker = async () => {
    while (failure === undefined && next < tasks.length) {
      const index = next++;
      try { results[index] = await tasks[index](); }
      catch (error) { failure ??= { index, error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  if (failure) throw failure.error;
  return results;
}
