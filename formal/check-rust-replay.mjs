import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './execution.mjs';

import { conformanceInventory } from './conformance.mjs';
import { nativeBinding } from './conformance-bindings.mjs';

// The Rust harness reports one JSON object per line: a start record, one
// record per executed case named by its shared inventory id, and a finish
// record with totals. Case ids are the inventory ids themselves (the Rust
// binding is the identity), so this gate reads the report against the common
// inventory directly, with no second list of required behavior.
const inventoryRoots = new Set(['sampled', 'regression', 'scenario', 'protocol', 'witness']);
const epochMs = value => Number.isSafeInteger(value) && value > 0;

/** Pure completed-report gate. Counts only exact passed case records, never totals the harness printed. */
export function checkRustReplay(report, inventory = conformanceInventory()) {
  if (typeof report !== 'string' || !report.trim()) throw new Error('Empty Rust replay report');
  if (!Array.isArray(inventory) || !inventory.length) throw new Error('Empty Rust replay inventory');
  const required = new Map(inventory.map(entry => [nativeBinding(entry, 'rust'), entry]));
  if (required.size !== inventory.length) throw new Error('Duplicate Rust case binding');
  const cases = new Map();
  let started, finish;
  for (const [index, line] of report.trim().split('\n').entries()) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`Invalid Rust JSON record at line ${index + 1}`); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.kind !== 'string') throw new Error(`Invalid Rust replay record at line ${index + 1}`);
    if (finish) throw new Error('Rust report continues after the finish record');
    if (event.kind === 'start') {
      if (started || index !== 0) throw new Error('Duplicate or misplaced Rust start record');
      if (event.schemaVersion !== 1 || event.implementation !== 'rust' || !epochMs(event.startedAt)) throw new Error('Unsupported Rust start record');
      started = event;
      continue;
    }
    if (!started) throw new Error('Rust replay record precedes the start record');
    if (event.kind === 'case') {
      const { id } = event;
      if (typeof id !== 'string' || !id) throw new Error(`Invalid Rust case id at line ${index + 1}`);
      if (event.status !== 'passed' && event.status !== 'failed') throw new Error(`Invalid Rust case status: ${id}`);
      if (!epochMs(event.startedAt) || !epochMs(event.finishedAt) || event.finishedAt < event.startedAt || event.startedAt < started.startedAt) throw new Error(`Invalid Rust case timing: ${id}`);
      if (event.message !== undefined && typeof event.message !== 'string') throw new Error(`Invalid Rust case message: ${id}`);
      if (event.status === 'failed') throw new Error(`Rust replay failed: ${id}${event.message ? ` (${event.message})` : ''}`);
      if (cases.has(id)) throw new Error(`Duplicate Rust replay case: ${id}`);
      if (!required.has(id)) {
        const segment = id.split('/')[0];
        if (segment === 'smoke') throw new Error(`Smoke history in a full Rust replay: ${id}`);
        if (inventoryRoots.has(segment)) throw new Error(`Unexpected Rust replay case (inventory drift): ${id}`);
        throw new Error(`Unknown Rust replay case: ${id}`);
      }
      cases.set(id, event);
    } else if (event.kind === 'finish') {
      if (event.status !== 'passed' && event.status !== 'failed') throw new Error('Invalid Rust finish status');
      if (event.status !== 'passed') throw new Error(`Rust replay finished with status ${event.status}`);
      if (!epochMs(event.finishedAt) || event.finishedAt < started.startedAt) throw new Error('Invalid Rust finish timing');
      if (event.cases !== cases.size || event.failed !== 0) throw new Error(`Rust finish totals disagree with the case records: ${event.cases} reported, ${cases.size} recorded, ${event.failed} failed`);
      finish = event;
    } else {
      throw new Error(`Unsupported Rust replay record kind: ${event.kind}`);
    }
  }
  if (!finish) throw new Error('Rust replay is incomplete: missing finish record');
  for (const id of required.keys()) if (!cases.has(id)) throw new Error(`Missing passed Rust replay case: ${id}`);
  const profiles = [...new Set(inventory.filter(entry => entry.profile).map(entry => entry.profile))];
  const count = (category, profile) => inventory.filter(entry => entry.category === category && (profile === undefined || entry.profile === profile)).length;
  const generated = Object.fromEntries(profiles.map(profile => [profile, count('sampled', profile)]));
  const quintRegressions = Object.fromEntries(profiles.map(profile => [profile, count('regression', profile)]));
  return { schemaVersion: 1, implementation: 'rust', status: 'pass',
    generated, generatedTraces: Object.values(generated).reduce((sum, n) => sum + n, 0),
    quintRegressions, quintRegressionTraces: Object.values(quintRegressions).reduce((sum, n) => sum + n, 0),
    fixedScenarios: count('scenario'), protocolVectors: count('protocol'),
    witnessProfiles: inventory.filter(entry => entry.category === 'witness').map(entry => entry.profile).sort(),
    executedCases: cases.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node formal/check-rust-replay.mjs [rust-replay.jsonl]');
  const path = process.argv[2] ? resolve(process.argv[2]) : root + '.formal-traces/rust-replay.jsonl';
  const report = readFileSync(path, 'utf8');
  const result = checkRustReplay(report, conformanceInventory());
  console.log(JSON.stringify({ ...result, reportSha256: createHash('sha256').update(report).digest('hex') }, null, 2));
}
