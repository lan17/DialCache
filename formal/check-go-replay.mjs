import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExecution, root, validateExecution } from './execution.mjs';

// These are the reviewed Go test bindings for every protocol vector group.
// Adding a vector changes the expected leaves automatically; adding a group
// requires reviewing its actual Go binding here instead of silently omitting it.
const protocolBindings = {
  keyVectors: 'TestProtocolKeys',
  invalidKeyVectors: 'TestProtocolKeys',
  frameVectors: 'TestProtocolFrames',
  trackedDecodeVectors: 'TestProtocolDecoders/trackedDecodeVectors',
  untrackedDecodeVectors: 'TestProtocolDecoders/untrackedDecodeVectors',
  rampVectors: 'TestProtocolCohorts',
  normalizeArgsVectors: 'TestProtocolRemainingVectors',
  invalidTimestampVectors: 'TestProtocolRemainingVectors',
  envelopeVectors: 'TestProtocolRemainingVectors',
  compressedDecodeVectors: 'TestProtocolRemainingVectors',
  compressionWriteVectors: 'TestProtocolRemainingVectors',
  durationVectors: 'TestProtocolRemainingVectors',
};

// Current fixture names are printable ASCII. Fail closed if that domain changes:
// Go testing also escapes nonprintable runes and disambiguates duplicate names.
const testName = name => {
  if (typeof name !== 'string' || !name || /[^\x20-\x7e]/.test(name) || name.includes('#')) {
    throw new Error(`Unsupported Go fixture test name: ${name}`);
  }
  return name.replaceAll(' ', '_');
};
const sameMembers = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Pure inventory construction; no test result or expected observation feeds execution. */
export function buildGoReplayInventory({ execution, scenarios, protocol, packageName }) {
  if (!packageName || !Array.isArray(execution.models) || !Array.isArray(scenarios.scenarios)) {
    throw new Error('Invalid Go replay input inventories');
  }
  const profiles = {}, required = new Map();
  const add = (name, category) => {
    if (required.has(name)) throw new Error(`Duplicate normalized Go case name: ${name}`);
    required.set(name, category);
  };
  for (const model of execution.models.filter(model => model.profile !== undefined)) {
    const { profile, generate } = model;
    if (!/^[a-z][a-z-]*$/.test(profile) || Object.hasOwn(profiles, profile) ||
        !Number.isSafeInteger(generate?.traces) || generate.traces <= 0) throw new Error('Invalid generated profile count');
    profiles[profile] = generate.traces;
    const prefix = profile === 'core' ? 'TestCoreConformance'
      : profile === 'effects' ? 'TestEffectsConformance' : `TestFeatureConformance/${profile}`;
    for (let i = 0; i < generate.traces; i++) add(`${prefix}/trace_${i}.itf.json`, `generated:${profile}`);
  }
  if (!profiles.core || !profiles.effects) throw new Error('Core and effects replay profiles are required');
  for (const scenario of scenarios.scenarios) {
    add(`TestBehaviorConformance/${testName(scenario.feature)}/${testName(scenario.name)}`, 'fixed');
  }
  if (!scenarios.scenarios.length) throw new Error('Empty fixed scenario inventory');
  const groups = Object.keys(protocol).filter(name => Array.isArray(protocol[name]));
  if (!sameMembers(groups, Object.keys(protocolBindings))) throw new Error('Review changed Go protocol vector group bindings');
  for (const [group, prefix] of Object.entries(protocolBindings)) {
    if (!protocol[group].length) throw new Error(`Empty protocol vector group: ${group}`);
    for (const vector of protocol[group]) add(`${prefix}/${testName(vector.name)}`, 'protocol');
  }
  const witnessProfiles = Object.keys(profiles).filter(profile => profile !== 'core').sort();
  for (const profile of witnessProfiles) add(`TestGeneratedWitnessEvidence/${profile}`, 'witness');
  return { packageName, profiles, witnessProfiles, required: [...required].map(([name, category]) => ({ name, category })) };
}

export function loadGoReplayInventory() {
  const execution = readExecution();
  validateExecution(execution);
  const read = path => readFileSync(root + path, 'utf8');
  const packageName = /^module\s+(\S+)\s*$/m.exec(read('go/go.mod'))?.[1];
  return buildGoReplayInventory({ execution, packageName,
    scenarios: JSON.parse(read('formal/behavioral-scenarios.json')),
    protocol: JSON.parse(read('formal/protocol-vectors.json')) });
}

/** Pure completed-report gate. Counts only exact passed case leaves, never log summaries. */
export function checkGoReplay(report, inventory) {
  if (typeof report !== 'string' || !report.trim()) throw new Error('Empty Go replay report');
  const tests = new Map();
  let started = false, complete = false;
  for (const [index, line] of report.trim().split('\n').entries()) {
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`Invalid Go JSON event at line ${index + 1}`); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid Go test event');
    if (['fail', 'skip', 'build-fail'].includes(event.Action)) throw new Error(`Go replay ${event.Action}: ${event.Test ?? event.Package ?? 'build'}`);
    if (event.Package !== inventory.packageName) throw new Error(`Unexpected Go replay package: ${event.Package}`);
    if (complete) throw new Error('Go report continues after package completion');
    const name = event.Test;
    if (name !== undefined && (typeof name !== 'string' || !name)) throw new Error('Invalid Go test name');
    if (event.Action === 'start') {
      if (started || name !== undefined) throw new Error('Duplicate or invalid Go package start');
      started = true;
      continue;
    }
    if (!started) throw new Error('Go test event precedes package start');
    if (event.Action === 'output') {
      if (typeof event.Output !== 'string') throw new Error('Invalid Go output event');
      continue;
    }
    if (event.Action === 'run') {
      if (!name || tests.has(name)) throw new Error(`Duplicate or invalid Go test run: ${name}`);
      if (name.includes('/') && tests.get(name.split('/')[0]) !== 'running') throw new Error(`Go subtest has no running parent: ${name}`);
      tests.set(name, 'running');
    } else if (event.Action === 'pause' || event.Action === 'cont') {
      const previous = event.Action === 'pause' ? 'running' : 'paused';
      if (!name || tests.get(name) !== previous) throw new Error(`Invalid Go ${event.Action}: ${name}`);
      tests.set(name, event.Action === 'pause' ? 'paused' : 'running');
    } else if (event.Action === 'pass' && name) {
      if (tests.get(name) !== 'running') throw new Error(`Unexpected Go test completion: ${name}`);
      if ([...tests].some(([child, state]) => child.startsWith(`${name}/`) && state !== 'pass')) throw new Error(`Go parent completed before its children: ${name}`);
      tests.set(name, 'pass');
    } else if (event.Action === 'pass') {
      if (!tests.size || [...tests.values()].some(state => state !== 'pass')) throw new Error('Go package completed with unfinished tests');
      complete = true;
    } else {
      throw new Error(`Unsupported Go replay action: ${event.Action}`);
    }
  }
  if (!complete) throw new Error('Go replay is incomplete: missing package pass');
  const names = [...tests.keys()], nonleaves = new Set();
  for (const name of names) {
    let parent = name;
    while (parent.includes('/')) {
      parent = parent.slice(0, parent.lastIndexOf('/'));
      nonleaves.add(parent);
    }
  }
  const required = new Map(inventory.required.map(entry => [entry.name, entry.category]));
  const protectedRoots = new Set([...required.keys()].map(name => name.split('/')[0]));
  const leaves = names.filter(name => !nonleaves.has(name));
  for (const name of required.keys()) {
    if (tests.get(name) !== 'pass' || nonleaves.has(name)) throw new Error(`Missing completed Go replay leaf: ${name}`);
  }
  for (const name of leaves) {
    if (protectedRoots.has(name.split('/')[0]) && !required.has(name)) throw new Error(`Unexpected Go replay leaf (smoke, duplicate, or inventory drift): ${name}`);
  }
  const count = category => inventory.required.filter(entry => entry.category === category).length;
  const generated = Object.fromEntries(Object.keys(inventory.profiles).map(profile => [profile, count(`generated:${profile}`)]));
  return { schemaVersion: 1, package: inventory.packageName, status: 'pass',
    generated, generatedTraces: Object.values(generated).reduce((sum, n) => sum + n, 0),
    fixedScenarios: count('fixed'), protocolVectors: count('protocol'), witnessProfiles: inventory.witnessProfiles,
    executedTests: tests.size, passedLeaves: leaves.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node formal/check-go-replay.mjs [go-replay.jsonl]');
  const path = process.argv[2] ? resolve(process.argv[2]) : root + '.formal-traces/go-replay.jsonl';
  const report = readFileSync(path, 'utf8');
  const result = checkGoReplay(report, loadGoReplayInventory());
  console.log(JSON.stringify({ ...result, reportSha256: createHash('sha256').update(report).digest('hex') }, null, 2));
}
