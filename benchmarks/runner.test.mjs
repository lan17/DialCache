import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseArgs, runWorker, selectCases } from './run.mjs';
import { validateCatalogue, validateResult } from './protocol.mjs';
import { comparison, percentile, summarize, validateArtifact } from './report.mjs';

const catalogue = JSON.parse(readFileSync(new URL('./cases.json', import.meta.url), 'utf8'));
const c = validateCatalogue(catalogue)[0];
const request = { version: 1, id: 'sample-1', case: c, payload: 'x'.repeat(c.payloadBytes), redisUrl: null };
const result = () => ({ version: 1, id: request.id, port: 'typescript', caseId: c.id, operations: c.iterations,
  elapsedNs: 40000, checksum: c.iterations * c.payloadBytes, valueValid: true,
  counters: { sourceCalls: c.iterations, redisReads: 0, redisWrites: 0, coalescedCalls: 0 },
  redisCommands: { get: 0, mget: 0, set: 0, eval: 0, evalsha: 0, time: 0 }, latencyNs: [],
  runtime: { version: 'test-runtime', workers: 1 } });

test('catalogue selection rejects typos and contradictory filters', () => {
  for (const args of [['--ports', 'python'], ['--ports', 'go,go'], ['--samples', 'NaN'], ['--samples', '0'],
    ['--suite', 'bad'], ['--unknown'], ['--suite']]) assert.throws(() => parseArgs(args));
  assert.throws(() => selectCases(catalogue, parseArgs(['--cases', 'does-not-exist'])));
  assert.throws(() => selectCases(catalogue, parseArgs(['--cases', 'redis-hit-1k'])));
  assert.throws(() => selectCases(catalogue, parseArgs(['--kinds', '__proto__'])));
  const smoke = selectCases(catalogue, parseArgs(['--suite', 'all', '--smoke']));
  assert.equal(smoke.length, catalogue.cases.length);
  assert(smoke.every(c => c.iterations <= 20 && c.warmup > 0));
  assert.throws(() => validateCatalogue({ version: 1, cases: [c, c] }));
});

for (const [name, corrupt] of [
  ['wrong sample', r => { r.id = 'another-request'; }],
  ['wrong case', r => { r.caseId = 'disabled'; }],
  ['wrong port', r => { r.port = 'go'; }],
  ['skipped operations', r => { r.operations--; }],
  ['skipped source work', r => { r.counters.sourceCalls = 0; }],
  ['wrong values', r => { r.valueValid = false; }],
  ['wrong checksum', r => { r.checksum--; }],
  ['zero elapsed', r => { r.elapsedNs = 0; }],
  ['nonfinite elapsed', r => { r.elapsedNs = Infinity; }],
  ['different concurrency', r => { r.runtime.workers = 4; }],
  ['hidden Redis activity', r => { r.redisCommands.get = 1; }],
]) {
  test(`reject misleading fast result: ${name}`, () => {
    const r = result(); corrupt(r);
    assert.throws(() => validateResult(r, request, 'typescript'));
  });
}

test('worker process failure and mixed stdout cannot become successful samples', async () => {
  const worker = script => [process.execPath, '-e', script];
  await assert.rejects(runWorker(worker('process.stderr.write("broken case");process.exit(1)'), request, 'typescript'), /broken case/);
  await assert.rejects(runWorker(worker('console.log("banner");console.log("{}")'), request, 'typescript'), /one JSON/);
  const actual = await runWorker(worker(`process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(result()))}))`), request, 'typescript');
  assert.deepEqual(actual, result());
});

test('Redis write results require exactly one SET and complete latency samples', () => {
  const write = catalogue.cases.find(c => c.id === 'redis-write-100b');
  const req = { ...request, case: write };
  const r = { ...result(), caseId: write.id, operations: write.iterations, checksum: write.iterations * write.payloadBytes,
    counters: { sourceCalls: 0, redisReads: 0, redisWrites: write.iterations, coalescedCalls: 0 },
    redisCommands: { get: 0, mget: 0, set: write.iterations, eval: 0, evalsha: 0, time: 0 },
    latencyNs: Array(write.iterations).fill(10) };
  validateResult(r, req, 'typescript');
  for (const mutate of [r => r.redisCommands.set--, r => r.redisCommands.eval++, r => r.latencyNs.pop(),
    r => { r.latencyNs[0] = NaN; }]) {
    const changed = structuredClone(r); mutate(changed);
    assert.throws(() => validateResult(changed, req, 'typescript'));
  }
});

function artifact() {
  return { version: 1, complete: true, cases: [c], ports: ['typescript'], samples: 1,
    results: [{ id: request.id, sample: 0, result: result() }],
    environment: { cpu: 'same cpu' }, builds: { typescript: 'same runtime' }, redis: null, smoke: false };
}

test('saved artifacts cannot hide missing, duplicate, or invalid samples', () => {
  const a = artifact();
  assert.equal(summarize(a)[0].median, 2);
  for (const corrupt of [a => { a.complete = false; }, a => a.results.pop(), a => a.results.push(a.results[0]),
    a => { a.samples = 2; a.results.push(a.results[0]); }, a => { a.results[0].sample = 2; }]) {
    const changed = structuredClone(a); corrupt(changed);
    assert.throws(() => validateArtifact(changed));
  }
});

test('comparison is per-port and refuses incompatible experiments', () => {
  const baseline = artifact(), current = artifact();
  current.results[0].result.elapsedNs *= 1.25;
  assert.equal(comparison(current, baseline)[0].changePercent, 25);
  for (const change of [a => { a.environment.cpu = 'different cpu'; }, a => { a.smoke = true; },
    a => { a.builds.typescript = 'different runtime'; }, a => { a.cases[0].capacity++; }]) {
    const changed = structuredClone(current); change(changed);
    assert.throws(() => comparison(changed, baseline));
  }
  assert.equal(percentile([90, 1, 2, 3], 0.5), 2);
  assert.equal(percentile([90, 1, 2, 3], 0.95), 90);
});
