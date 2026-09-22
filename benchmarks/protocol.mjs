import assert from 'node:assert/strict';

export const ports = ['typescript', 'go', 'rust'];
export const definitions = {
  'source-baseline': ['core', 'none'],
  disabled: ['core', 'none'],
  'enabled-uncached': ['core', 'single'],
  'request-local-hit': ['core', 'single'],
  'process-local-hit': ['core', 'per-operation'],
  'local-eviction': ['core', 'per-operation'],
  'request-coalescing': ['core', 'per-burst'],
  'process-coalescing': ['core', 'per-operation'],
  'redis-hit': ['redis', 'per-operation'],
  'redis-tracked-hit': ['redis', 'per-operation'],
  'redis-write': ['redis', 'none'],
};
export const isBurst = c => c.kind.endsWith('-coalescing');
export const operations = c => c.iterations * (isBurst(c) ? c.fanout : 1);
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  assert(Number.isSafeInteger(value) && value >= min && value <= max, `${name}: invalid integer`);
}

export function validateCase(c) {
  assert(c && /^[a-z][a-z0-9-]*$/.test(c.id), 'Invalid case id');
  assert(Object.hasOwn(definitions, c.kind), `Unknown case kind: ${c.kind}`);
  assert.deepEqual([c.suite, c.scope], definitions[c.kind], `${c.id}: suite/scope mismatch`);
  integer(c.iterations, 'iterations', 1, 1_000_000);
  integer(c.warmup, 'warmup', 1, 1_000_000);
  integer(c.fanout, 'fanout', isBurst(c) ? 2 : 1, isBurst(c) ? 1024 : 1);
  integer(c.capacity, 'capacity', 1, 100_000);
  integer(c.payloadBytes, 'payloadBytes', 1, 1_048_576);
  integer(operations(c), 'operations', 1, 1_000_000);
  if (c.kind !== 'redis-write') {
    assert(Math.max(c.iterations, c.warmup) * c.fanout * c.payloadBytes <= 128 * 1024 * 1024,
      `${c.id}: retained results exceed the 128 MiB workload limit`);
  }
  return c;
}

export function validateCatalogue(catalogue) {
  assert.equal(catalogue?.version, 1, 'Unsupported catalogue version');
  assert(Array.isArray(catalogue.cases) && catalogue.cases.length, 'Empty catalogue');
  catalogue.cases.forEach(validateCase);
  assert.equal(new Set(catalogue.cases.map(c => c.id)).size, catalogue.cases.length, 'Duplicate case id');
  return catalogue.cases;
}

export function validateResult(result, request, port) {
  const c = validateCase(request.case);
  assert(ports.includes(port), 'Unknown port');
  assert.equal(result?.version, 1, 'Unsupported worker result version');
  assert.equal(result.id, request.id, 'Worker sample id mismatch');
  assert.equal(result.port, port, 'Worker port mismatch');
  assert.equal(result.caseId, c.id, 'Worker case mismatch');
  assert.equal(result.operations, operations(c), 'Incomplete operation count');
  assert(Number.isFinite(result.elapsedNs) && result.elapsedNs > 0, 'Invalid elapsed time');
  assert.equal(result.checksum, operations(c) * c.payloadBytes, 'Result checksum mismatch');
  assert.equal(result.valueValid, true, 'Worker value validation failed');
  const sourceCalls = ['source-baseline', 'disabled', 'enabled-uncached', 'local-eviction'].includes(c.kind) || isBurst(c)
    ? c.iterations : 0;
  assert.deepEqual(result.counters, {
    sourceCalls,
    redisReads: ['redis-hit', 'redis-tracked-hit'].includes(c.kind) ? c.iterations : 0,
    redisWrites: c.kind === 'redis-write' ? c.iterations : 0,
    coalescedCalls: isBurst(c) ? c.iterations * (c.fanout - 1) : 0,
  }, `${c.id}: workload behavior changed`);
  for (const name of ['get', 'mget', 'set', 'eval', 'evalsha', 'time']) {
    integer(result.redisCommands?.[name], `Redis ${name}`);
    if (c.suite === 'core') assert.equal(result.redisCommands[name], 0, 'Core workload issued Redis commands');
  }
  if (c.kind === 'redis-write') {
    assert.equal(result.redisCommands.set, c.iterations, 'Expected one SET per write');
    for (const name of ['get', 'mget', 'eval', 'evalsha', 'time']) {
      assert.equal(result.redisCommands[name], 0, `Unexpected ${name} during writes`);
    }
  } else if (c.suite === 'redis') {
    const commands = result.redisCommands;
    assert(commands.get + commands.mget + commands.eval + commands.evalsha >= c.iterations,
      'Redis hits did not execute real reads');
    assert.equal(commands.set, 0, 'Redis hits unexpectedly wrote values');
  }
  assert(Array.isArray(result.latencyNs), 'Missing latency samples');
  assert.equal(result.latencyNs.length, c.suite === 'redis' ? operations(c) : 0, 'Incomplete latency samples');
  assert(result.latencyNs.every(n => Number.isFinite(n) && n >= 0), 'Invalid latency sample');
  assert.equal(result.runtime?.workers, 1, 'Expected single-worker runtime');
  assert(typeof result.runtime.version === 'string' && result.runtime.version.length > 0, 'Missing runtime version');
  return result;
}
