import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { conformanceInventory } from './conformance.mjs';
import { root } from './execution.mjs';

const timestamp = value => Number.isSafeInteger(value) && value > 0;

// Exact assertion records, never a test count or a command's exit status, own
// completion. Smoke/selected/behavior-only reports cannot be relabeled complete.
export function checkPythonReplay(text, inventory = conformanceInventory(), { corpus } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('Empty Python replay report');
  if (!Array.isArray(inventory) || !inventory.length) throw new Error('Empty Python replay inventory');
  const required = new Map(inventory.map(entry => [entry.id, entry]));
  if (required.size !== inventory.length) throw new Error('Duplicate Python conformance inventory');
  const cases = new Map();
  let start, finish;
  for (const [index, line] of text.trim().split('\n').entries()) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`Invalid Python JSON record at line ${index + 1}`); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid Python replay record');
    if (finish) throw new Error('Python report continues after its finish record');
    if (event.kind === 'start') {
      if (index !== 0 || start) throw new Error('Duplicate or misplaced Python start record');
      if (event.schemaVersion !== 1 || event.implementation !== 'python' || event.scope !== 'conformance'
        || event.selection !== 'generated' || event.partial !== false || !timestamp(event.startedAt)) {
        throw new Error('Python report is not a complete conformance execution');
      }
      start = event;
    } else if (event.kind === 'case') {
      if (!start) throw new Error('Python case precedes its start record');
      if (!required.has(event.id)) throw new Error(`Unknown Python conformance case: ${event.id}`);
      if (cases.has(event.id)) throw new Error(`Duplicate Python conformance case: ${event.id}`);
      if (event.status !== 'passed') throw new Error(`Python replay failed or skipped: ${event.id}${event.message ? ` (${event.message})` : ''}`);
      if (!timestamp(event.startedAt) || !timestamp(event.finishedAt) || event.startedAt < start.startedAt || event.finishedAt < event.startedAt) {
        throw new Error(`Invalid Python case timing: ${event.id}`);
      }
      if (required.get(event.id).path && !/^[a-f\d]{64}$/.test(event.historySha256 ?? '')) throw new Error(`Missing Python history fingerprint: ${event.id}`);
      if (required.get(event.id).path && corpus !== undefined
        && event.historySha256 !== corpus[required.get(event.id).path]) throw new Error(`Python history fingerprint differs from its execution context: ${event.id}`);
      cases.set(event.id, event);
    } else if (event.kind === 'finish') {
      if (!start || event.status !== 'passed' || event.failed !== 0 || event.cases !== cases.size
        || !timestamp(event.finishedAt) || event.finishedAt < start.startedAt
        || [...cases.values()].some(item => item.finishedAt > event.finishedAt)) throw new Error('Incomplete or inconsistent Python finish record');
      finish = event;
    } else throw new Error(`Unsupported Python report record: ${event.kind}`);
  }
  if (!finish) throw new Error('Python replay is incomplete: missing finish record');
  for (const id of required.keys()) if (!cases.has(id)) throw new Error(`Missing passed Python conformance case: ${id}`);
  const counts = {};
  for (const entry of inventory) counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  return { schemaVersion: 1, implementation: 'python', status: 'pass', executedCases: cases.size, counts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node formal/check-python-replay.mjs [python-replay.jsonl]');
  const path = process.argv[2] ? resolve(process.argv[2]) : resolve(root, '.formal-traces/python-replay.jsonl');
  const text = readFileSync(path, 'utf8');
  const inventory = conformanceInventory();
  const corpus = Object.fromEntries(inventory.filter(entry => entry.path).map(entry => [entry.path,
    createHash('sha256').update(readFileSync(resolve(root, entry.path))).digest('hex')]));
  console.log(JSON.stringify({ ...checkPythonReplay(text, inventory, { corpus }), reportSha256: createHash('sha256').update(text).digest('hex') }, null, 2));
}
