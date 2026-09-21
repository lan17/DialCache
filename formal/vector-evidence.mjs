import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { countingPaths, diffPaths } from './replay/divergence.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const hex = value => typeof value === 'string' && /^(?:[a-f0-9]{2})*$/.test(value);
const natural = value => Number.isSafeInteger(value) && value >= 0;
const readOutcomes = new Set(['passthrough', 'decompressed', 'fallback_raw', 'read_over_limit']);
const writeOutcomes = new Set(['compressed', 'below_threshold', 'not_smaller', 'write_over_limit']);
const missReasons = new Set(['value_absent', 'expired', 'watermark_fenced', 'unclassified']);
const fieldsByGroup = {
  vectors: ['outcome', 'kind', 'content', 'ttlMs'],
  keyVectors: ['kind', 'logicalKey', 'valueKey', 'watermarkKey'],
  trackedDecodeVectors: ['kind', 'reason', 'observedWatermarkMs', 'createdAtMs', 'payloadType', 'payloadHex', 'payloadUtf8'],
  envelopeVectors: ['decodedHex', 'outcome'],
  compressionWriteVectors: ['outcome', 'storedBytes', 'marker'],
};

// These adapters split a generated vector into external input and expected
// public output. Only the input crosses into either native process.
function sample(group, row, port) {
  switch (group) {
    case 'vectors': return { operation: 'invalidation',
      input: { existing: row.existing, futureBufferMs: row.futureBufferMs, invalidatedAtMs: row.invalidatedAtMs },
      expected: { outcome: row.expected.error ? 'rejected' : 'success', kind: row.expected.state.kind,
        content: row.expected.state.kind === 'string' ? row.expected.state.value : row.expected.state.kind === 'list' ? row.expected.state.values : [],
        ttlMs: row.expected.state.ttlMs, elapsedMs: 0 } };
    case 'keyVectors': return { operation: 'key', input: row.input,
      expected: { kind: 'key', logicalKey: row.logicalKey, valueKey: row.valueKey, watermarkKey: row.watermarkKey } };
    case 'trackedDecodeVectors': return { operation: 'trackedDecode',
      input: { frameHex: row.frameHex, watermarkUtf8: row.watermarkUtf8 ?? null }, expected: row.expected };
    case 'envelopeVectors': return { operation: 'envelope', input: { inputHex: row.inputHex },
      expected: { decodedHex: row.decodedHex, outcome: row.outcome } };
    case 'compressionWriteVectors': return { operation: 'compression',
      input: { payloadType: row.payloadType, ...(row.payloadType === 'binary' ? { payloadHex: row.payloadHex } : { payloadUtf8: row.payloadUtf8 }),
        thresholdBytes: row.thresholdBytes, maxDecompressedBytes: row.maxDecompressedBytes }, expected: row.expectedByBinding?.[port] };
    default: throw new Error(`Unsupported vector boundary group: ${group}`);
  }
}

export function validVectorResult(operation, value) {
  if (!object(value)) return false;
  if (operation === 'invalidation') return exact(value, ['outcome', 'kind', 'content', 'ttlMs', 'elapsedMs'])
    && ['success', 'rejected'].includes(value.outcome) && ['absent', 'string', 'list'].includes(value.kind)
    && (value.kind === 'string' ? typeof value.content === 'string' : Array.isArray(value.content)
      && value.content.every(item => typeof item === 'string') && (value.kind === 'list' ? value.content.length > 0 : value.content.length === 0))
    && Number.isSafeInteger(value.ttlMs) && value.ttlMs >= -2 && natural(value.elapsedMs);
  if (operation === 'key') return value.kind === 'key_error' ? exact(value, ['kind']) :
    exact(value, ['kind', 'logicalKey', 'valueKey', 'watermarkKey']) && value.kind === 'key'
      && typeof value.logicalKey === 'string' && typeof value.valueKey === 'string'
      && (value.watermarkKey === null || typeof value.watermarkKey === 'string');
  if (operation === 'envelope') return exact(value, ['decodedHex', 'outcome']) && hex(value.decodedHex) && readOutcomes.has(value.outcome);
  if (operation === 'compression') return exact(value, ['outcome', 'storedBytes', 'marker']) && writeOutcomes.has(value.outcome)
    && natural(value.storedBytes) && [-1, 1, 2].includes(value.marker);
  if (operation !== 'trackedDecode') return false;
  if (value.kind === 'payload_encoding_error') return exact(value, ['kind']);
  if (value.kind === 'miss') return exact(value, ['kind', 'reason', ...(value.observedWatermarkMs === undefined ? [] : ['observedWatermarkMs'])])
    && missReasons.has(value.reason) && (value.observedWatermarkMs === undefined || natural(value.observedWatermarkMs));
  const binary = value.payloadType === 'binary';
  return value.kind === 'hit' && exact(value, ['kind', 'createdAtMs', 'payloadType', binary ? 'payloadHex' : 'payloadUtf8'])
    && natural(value.createdAtMs) && (binary ? hex(value.payloadHex) : value.payloadType === 'string' && typeof value.payloadUtf8 === 'string');
}

export function resolveVectorEvidence(written, model, readSource) {
  if (!exact(written, ['artifact', 'group', 'rows', 'fields', 'relation']) || written.artifact !== model.vectorExport?.artifact
    || !Object.hasOwn(fieldsByGroup, written.group) || !exact(written.rows, ['typescript', 'go'])
    || typeof written.relation !== 'string' || written.relation.trim().length < 30
    || !Array.isArray(written.fields) || !written.fields.length || new Set(written.fields).size !== written.fields.length
    || written.fields.some(field => !fieldsByGroup[written.group].includes(field))) throw new Error('Invalid vector boundary declaration');
  const text = readSource(written.artifact), corpus = JSON.parse(text), rows = corpus[written.group];
  if (!Array.isArray(rows)) throw new Error('Missing vector boundary group');
  const samples = {};
  for (const port of ['typescript', 'go']) {
    const matches = rows.filter(row => row.name === written.rows[port]);
    if (typeof written.rows[port] !== 'string' || matches.length !== 1) throw new Error(`Vector boundary must select exactly one ${port} row`);
    const selected = sample(written.group, matches[0], port);
    if (!validVectorResult(selected.operation, selected.expected) || written.fields.some(field => !Object.hasOwn(selected.expected, field)))
      throw new Error(`Malformed ${port} vector expectation or absent assertion field`);
    const request = { operation: selected.operation, input: selected.input };
    samples[port] = { row: matches[0].name, request, expected: selected.expected, inputSha256: hash(JSON.stringify(request)) };
  }
  return { ...written, artifactSha256: hash(text), samples };
}

// Recompute the comparison from the native value, not a test's failure count
// or the verdict in an older report. A missing, malformed or stale result
// remains an infrastructure failure and cannot earn detection credit.
export function assessVectorBoundary(evidence, recording) {
  const base = { ...evidence, via: 'vector', completed: recording?.completed === true, lastStep: recording?.lastStep ?? -1,
    ...(recording?.vectorResult ? { vectorResult: recording.vectorResult } : {}) };
  const fail = reason => ({ ...base, state: 'unreached', reason, divergences: [] });
  if (!recording || recording.completed !== true || recording.error !== undefined || recording.lastStep !== 0)
    return fail(recording?.error ?? 'No completed native vector result');
  const result = recording.vectorResult, selected = evidence.vector.samples[result?.port];
  if (!selected || result.history !== evidence.history || result.row !== selected.row
    || result.artifactSha256 !== evidence.vector.artifactSha256 || result.inputSha256 !== selected.inputSha256)
    return fail('Vector identity or source fingerprint differs from the declaration');
  if (!validVectorResult(selected.request.operation, result.actual)) return fail('Malformed native vector result');
  const expected = { ...selected.expected }, actual = { ...result.actual };
  if (selected.request.operation === 'invalidation') {
    // Redis 6.2 advances TTL time even inside an atomic Lua execution. Only
    // measured server elapsed time may explain a smaller positive TTL.
    delete expected.elapsedMs; delete actual.elapsedMs;
    if (expected.ttlMs >= 0 && actual.ttlMs >= Math.max(0, expected.ttlMs - result.actual.elapsedMs)
      && actual.ttlMs <= expected.ttlMs) actual.ttlMs = expected.ttlMs;
  }
  const paths = diffPaths(expected, actual);
  const matched = countingPaths(evidence.fields, paths, []);
  return { ...base, state: matched.length ? 'confirmed' : paths.length ? 'side-effect-only' : 'not-divergent',
    divergences: paths.length ? [{ step: 0, action: selected.request.operation, paths }] : [], ...(matched.length ? { matched } : {}) };
}
