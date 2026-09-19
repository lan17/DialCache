import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExecution, root } from './execution.mjs';
import { CommandFailure, printGroup, runPool, seconds, spawnBuffered } from './quint-pool.mjs';

// The kernel library's transitions are pure, so the seams a scheduled profile
// may not reach yet (held policy replies, release order, coalescing off,
// closure between admission and release) are exercised by small profiles under
// test/fixtures/kernel. Each typechecks and every declared run passes; the
// check runs wherever Quint is present (the model check and the differential
// lanes) so a library change cannot move them unnoticed.
export const fixtureDirectory = 'test/fixtures/kernel';

export function kernelFixtures(directory = root) {
  return readdirSync(resolve(directory, fixtureDirectory)).filter(name => name.endsWith('.qnt')).sort()
    .map(name => `${fixtureDirectory}/${name}`);
}

// Every run a fixture declares; `quint test` runs only those whose name ends
// in Test unless told otherwise, so the declared names are matched explicitly.
// Declared runs matched per `quint test` invocation.
export const RUNS_PER_INVOCATION = 12;

export function declaredRuns(source) {
  return [...source.matchAll(/^\s*run\s+(\w+)/gm)].map(match => match[1]);
}

async function checkFixture(model, { settings, seed, directory, timeoutMs }) {
  const runs = declaredRuns(readFileSync(resolve(directory, model), 'utf8'));
  if (!runs.length) throw new Error(`${model} declares no runs`);
  const typecheck = await spawnBuffered('quint', ['typecheck', model], { cwd: directory, timeoutMs });
  if (typecheck.status !== 0) throw new CommandFailure(`typecheck of ${model} failed (exit ${typecheck.status}):\n${typecheck.stderr}${typecheck.stdout}`, typecheck);
  // The declared names are matched in batches: one alternation over a large
  // fixture makes an argument long enough for some hosts to refuse the process.
  let log = '', passing = 0, durationMs = typecheck.durationMs;
  for (let start = 0; start < runs.length; start += RUNS_PER_INVOCATION) {
    const batch = runs.slice(start, start + RUNS_PER_INVOCATION);
    const test = await spawnBuffered('quint', ['test', model, `--backend=${settings.backend}`, '--max-samples=1', `--seed=${seed}`,
      `--match=^(${batch.join('|')})$`], { cwd: directory, timeoutMs });
    const output = test.stdout + test.stderr;
    const passed = Number(/(\d+) passing/.exec(output)?.[1] ?? NaN);
    log += output;
    durationMs += test.durationMs;
    if (test.status !== 0 || passed !== batch.length) {
      throw new CommandFailure(`runs of ${model} failed (exit ${test.status}, ${passed} of ${batch.length} declared runs in the batch passed):\n${log}`, test);
    }
    passing += passed;
  }
  return { model, runs: passing, log, durationMs };
}

export async function checkKernelFixtures({ directory = root, manifest = readExecution(), seed = process.env.QUINT_SEED || manifest.settings.seed, timeoutMs = 300_000 } = {}) {
  const models = kernelFixtures(directory);
  if (!models.length) throw new Error(`No kernel fixtures under ${fixtureDirectory}`);
  const results = await runPool(models.map(model => () => checkFixture(model, { settings: manifest.settings, seed, directory, timeoutMs })));
  for (const result of results) printGroup(`${result.model}: ${result.runs} runs (${seconds(result.durationMs)})`, result.log);
  return { fixtures: results.length, runs: results.reduce((count, result) => count + result.runs, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('Usage: node formal/check-kernel-fixtures.mjs');
  console.log(await checkKernelFixtures());
}
