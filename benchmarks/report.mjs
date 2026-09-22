import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isBurst, validateCase, validateResult } from './protocol.mjs';

export function percentile(values, p) {
  assert(values.length, 'No samples');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

export function validateArtifact(artifact) {
  assert.equal(artifact?.version, 1, 'Unsupported artifact');
  assert.equal(artifact.complete, true, 'Incomplete benchmark artifact');
  assert(Array.isArray(artifact.cases) && artifact.cases.length, 'Missing cases');
  assert(Array.isArray(artifact.ports) && artifact.ports.length, 'Missing ports');
  assert(Number.isSafeInteger(artifact.samples) && artifact.samples > 0, 'Missing repetition count');
  assert.equal(new Set(artifact.cases.map(c => c.id)).size, artifact.cases.length, 'Duplicate case');
  assert.equal(new Set(artifact.ports).size, artifact.ports.length, 'Duplicate port');
  assert.equal(artifact.results?.length, artifact.cases.length * artifact.ports.length * artifact.samples, 'Missing results');
  const seen = new Set();
  for (const entry of artifact.results) {
    const c = artifact.cases.find(c => c.id === entry.result?.caseId);
    validateCase(c);
    assert(artifact.ports.includes(entry.result.port), 'Unexpected result port');
    assert(Number.isSafeInteger(entry.sample) && entry.sample >= 0 && entry.sample < artifact.samples, 'Invalid repetition');
    const key = `${entry.result.port}/${c.id}/${entry.sample}`;
    assert(!seen.has(key), 'Duplicate result');
    seen.add(key);
    validateResult(entry.result, { case: c, id: entry.id }, entry.result.port);
  }
  return artifact;
}

export function summarize(artifact) {
  validateArtifact(artifact);
  return artifact.cases.flatMap(c => artifact.ports.map(port => {
    const results = artifact.results.filter(e => e.result.port === port && e.result.caseId === c.id).map(e => e.result);
    const times = results.map(r => r.elapsedNs / (isBurst(c) ? c.iterations : r.operations));
    const latency = results.flatMap(r => r.latencyNs);
    return { case: c.id, port, unit: isBurst(c) ? 'ns/burst' : 'ns/op', median: percentile(times, 0.5),
      min: Math.min(...times), max: Math.max(...times),
      ...(latency.length ? { p50: percentile(latency, 0.5), p95: percentile(latency, 0.95) } : {}) };
  }));
}

export function comparison(current, baseline) {
  validateArtifact(current);
  validateArtifact(baseline);
  // Compare only recorded experiments with matching workload and environment.
  for (const field of ['environment', 'builds', 'redis', 'smoke']) {
    assert.deepEqual(current[field], baseline[field], `Cannot compare different ${field}`);
  }
  const oldRows = summarize(baseline);
  return summarize(current).map(row => {
    const oldCase = baseline.cases.find(c => c.id === row.case);
    const currentCase = current.cases.find(c => c.id === row.case);
    assert.deepEqual(currentCase, oldCase, `Cannot compare changed workload ${row.case}`);
    const before = oldRows.find(r => r.case === row.case && r.port === row.port);
    assert(before, `Missing baseline ${row.port}/${row.case}`);
    return { ...row, changePercent: (row.median / before.median - 1) * 100 };
  });
}

export function printReport(artifact, baseline) {
  console.table((baseline ? comparison(artifact, baseline) : summarize(artifact)).map(row => ({
    case: row.case, port: row.port, unit: row.unit, median: row.median.toFixed(1),
    'min–max': `${row.min.toFixed(1)}–${row.max.toFixed(1)}`,
    ...(row.p50 === undefined ? {} : { 'p50 ns': row.p50.toFixed(1), 'p95 ns': row.p95.toFixed(1) }),
    ...(row.changePercent === undefined ? {} : { 'change %': row.changePercent.toFixed(1) }),
  })));
  console.log('Informational timings; min–max is across process samples. Burst rows are not sustained throughput.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [current, baseline] = process.argv.slice(2);
    assert(current, 'Usage: node benchmarks/report.mjs result.json [baseline.json]');
    printReport(JSON.parse(readFileSync(current, 'utf8')), baseline && JSON.parse(readFileSync(baseline, 'utf8')));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
