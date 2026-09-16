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
export function declaredRuns(source) {
  return [...source.matchAll(/^\s*run\s+(\w+)/gm)].map(match => match[1]);
}

async function checkFixture(model, { settings, seed, directory, timeoutMs }) {
  const runs = declaredRuns(readFileSync(resolve(directory, model), 'utf8'));
  if (!runs.length) throw new Error(`${model} declares no runs`);
  const typecheck = await spawnBuffered('quint', ['typecheck', model], { cwd: directory, timeoutMs });
  if (typecheck.status !== 0) throw new CommandFailure(`typecheck of ${model} failed (exit ${typecheck.status}):\n${typecheck.stderr}${typecheck.stdout}`, typecheck);
  const test = await spawnBuffered('quint', ['test', model, `--backend=${settings.backend}`, '--max-samples=1', `--seed=${seed}`,
    `--match=^(${runs.join('|')})$`], { cwd: directory, timeoutMs });
  const log = test.stdout + test.stderr;
  const passing = Number(/(\d+) passing/.exec(log)?.[1] ?? NaN);
  if (test.status !== 0 || passing !== runs.length) {
    throw new CommandFailure(`runs of ${model} failed (exit ${test.status}, ${passing} of ${runs.length} declared runs passed):\n${log}`, test);
  }
  return { model, runs: passing, log, durationMs: typecheck.durationMs + test.durationMs };
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
