// Generated read views of the catalogs and the replay descriptors. The JSON
// catalogs and the descriptor modules stay the source of truth; these pages
// exist so a reader can see what a profile's drivers do without opening the
// JavaScript, and so an agent gets the same facts in one file. `--write`
// regenerates every view under formal/generated/, `--check` fails when a
// committed view differs from what the sources render (the `audit` lane).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profiles as featureProfiles } from '../replay/features.mjs';
import { effectsDescriptor, inputsFor as effectsInputs, observedFields as effectsObservedFields, project as projectEffects } from '../replay/effects.mjs';
import { localClockDescriptor, localClockInput } from '../replay/local-clock.mjs';
import { actionNames as coreActionNames, coreCommands, observationFields as coreObservationFields } from '../replay/core.mjs';
import { fixtureFor, setupFor } from '../replay/bindings.mjs';
import { emptyObservation } from '../replay/observation.mjs';
import { scheduleExecution } from './execution.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const views = { profiles: 'formal/generated/PROFILES.md', challenges: 'formal/generated/CHALLENGES.md', mutants: 'formal/generated/MUTANTS.md' };
const json = (path, directory = root) => JSON.parse(readFileSync(resolve(directory, path), 'utf8'));
const code = value => `\`${JSON.stringify(value)}\``;
const text = value => String(value).replaceAll('|', '\\|');

// The replay descriptor of each profile, in one shape: the fixture and the
// setup commands by init choice (from bindings.mjs, the same functions the
// coordinator uses), the actions, each decoding a recorded choice into the
// driver commands for that step, and the observation channels the parser
// compares.
export function describeProfile(id) {
  const effectsRecord = Object.keys(projectEffects({ ...Object.fromEntries(effectsObservedFields.map(field => [field, 0])), calls: [], writeTtls: [], events: [] }));
  if (id === 'core') {
    return { kind: 'core', initChoices: undefined, fixture: () => fixtureFor(id), setup: () => setupFor(id),
      actions: Object.fromEntries(coreActionNames.filter(name => name !== 'init').map(name => [name, { decode: () => coreCommands(name) }])),
      channels: [{ name: 'o', fields: coreObservationFields, note: 'the model fields observable through the public API' }] };
  }
  if (id === 'effects') {
    return { kind: 'effects', initChoices: [0, 1, 2, 3, 4, 5], fixture: choice => fixtureFor(id, choice), setup: choice => setupFor(id, choice),
      actions: Object.fromEntries(Object.entries(effectsDescriptor.actions).map(([name, action]) => [name,
        { choices: action.choices, decode: (choice, observed, environment) => effectsInputs({ action: name, choice }, observed, environment) }])),
      channels: [{ name: 'o', fields: effectsRecord, note: 'the effects record the parser compares: counters, caller codes, physical write TTLs, the ordered event trail, read contexts and aborts' }] };
  }
  if (id === 'local-clock') {
    return { kind: 'local-clock', initChoices: undefined, fixture: () => fixtureFor(id), setup: () => setupFor(id),
      actions: Object.fromEntries(Object.entries(localClockDescriptor.actions).map(([name, action]) => [name, { choices: action.choices, decode: choice => localClockInput(name, choice) }])),
      channels: [{ name: 'o', fields: Object.keys(emptyObservation()), note: 'the shared observation record' }] };
  }
  const descriptor = featureProfiles[id];
  if (!descriptor) throw new Error(`No replay descriptor for profile ${id}`);
  const channels = [{ name: 'o', fields: Object.keys(emptyObservation()), note: 'the shared observation record' }];
  if (descriptor.readIO) channels.push({ name: 'io', fields: ['budgets', 'aborted', 'sourceErrors'], note: 'read budgets in dispatch order, aborted read indices, each caller\'s source-error identity' });
  if (descriptor.diagnosticAge !== undefined) {
    const ages = descriptor.diagnosticAge === 'none' ? 'no age events are selected' : `ages are the \`${descriptor.diagnosticAge}\` events`;
    channels.push({ name: 'd', fields: ['ages', 'coalesced', 'fallbackErrors', 'warnings', ...(descriptor.diagnosticConfigErrors ? ['configErrors'] : []), ...(descriptor.diagnosticFutureOffsets ? ['futureOffsets'] : []), ...(descriptor.diagnosticInspections ? ['inspections'] : [])], note: `diagnostics; ${ages}` });
  }
  if (descriptor.markerIO) channels.push({ name: 'markers', fields: ['cutoffMs', 'ttlMs'], note: 'one record per observed invalidation marker' });
  if (descriptor.compressionIO) channels.push({ name: 'compression', fields: ['decompressed', 'fallback_raw'], note: 'one outcome per decode' });
  if (descriptor.policyErrorIO) channels.push({ name: 'policyErrors', fields: ['layer', 'errorType'], note: 'one record per configuration error' });
  return { kind: 'features', initChoices: descriptor.initChoices, fixture: choice => fixtureFor(id, choice), setup: choice => setupFor(id, choice),
    actions: Object.fromEntries(Object.entries(descriptor.actions).map(([name, action]) => [name, { choices: action.choices, decode: (choice, observed, environment) => action.input(choice, observed, environment) }])),
    channels };
}

// Decode a choice with probes standing in for the observation and the
// environment. The observation probe has the shape of the shared record:
// every counter reads as 1 (one effect so far), every list as empty, and an
// unknown field is an error; the environment probe reads the wall clock as
// 0. The keys a decoder touches are reported per choice, so the page can say
// which decodings depend on the step.
export function decodeWithProbes(decode, choice) {
  const touched = new Set();
  const shape = emptyObservation();
  const observed = new Proxy({}, { get: (_, key) => {
    if (typeof key !== 'string') return undefined;
    if (!Object.hasOwn(shape, key)) throw new Error(`decoder reads an unknown observation field: ${key}`);
    touched.add(`observation.${key}`);
    return Array.isArray(shape[key]) ? [] : 1;
  } });
  const environment = new Proxy({}, { get: (_, key) => { if (typeof key === 'string') touched.add(`environment.${key}`); return 0; } });
  const input = decode(choice, observed, environment);
  return { input, touched: [...touched] };
}

const range = choices => {
  if (choices === 'index') return 'any read or loader index';
  if (!choices?.length) return 'none';
  const contiguous = choices.every((value, index) => index === 0 || value === choices[index - 1] + 1);
  return contiguous && choices.length > 2 ? `${choices[0]}..${choices.at(-1)}` : choices.join(', ');
};

// Consecutive decodings that differ in exactly one numeric field are a
// counter walking up (an effect index, a loader index); only such a run is
// abbreviated. Anything else, a payload class per choice or an overlay per
// choice, is shown in full, because the page is where those are read.
function singleNumericStep(a, b) {
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let differing = 0;
  for (const key of keys) {
    if (JSON.stringify(a[key]) === JSON.stringify(b[key])) continue;
    if (typeof a[key] !== 'number' || typeof b[key] !== 'number') return false;
    differing++;
  }
  return differing === 1;
}

function renderAction(profile, name, action) {
  const choices = action.choices === 'index' ? [0] : action.choices ?? [undefined];
  const examples = choices.map(choice => {
    try { return { choice, ...decodeWithProbes(action.decode, choice) }; }
    catch (error) { throw new Error(`${profile}.${name} choice ${choice}: ${error.message}`); }
  });
  const show = example => text(example.choice === undefined ? code(example.input) : `${example.choice} → ${code(example.input)}`);
  const counterWalk = examples.length > 12 && examples.every((example, index) => index === 0 || singleNumericStep(examples[index - 1].input, example.input));
  let cell = counterWalk ? [...examples.slice(0, 6).map(show), '… one more per choice …', ...examples.slice(-2).map(show)].join('<br>') : examples.map(show).join('<br>');
  const byKey = new Map();
  for (const example of examples) for (const key of example.touched) byKey.set(key, [...(byKey.get(key) ?? []), example.choice]);
  for (const [key, keyChoices] of byKey) {
    const which = keyChoices.length === examples.length ? 'every decoding' : `choice${keyChoices.length === 1 ? '' : 's'} ${keyChoices.join(', ')}`;
    const meaning = key.startsWith('environment.') ? 'the environment value at the step; shown as 0' : 'the count so far at the step; shown with one so far';
    cell += `<br>${which} ${keyChoices.length === 1 || keyChoices.length === examples.length ? 'reads' : 'read'} \`${key}\` (${meaning})`;
  }
  return `| \`${name}\` | ${range(action.choices)} | ${cell} |`;
}

export function renderProfiles({ directory = root } = {}) {
  const registry = json('formal/catalogs/profiles.json', directory);
  const execution = scheduleExecution(json('formal/catalogs/execution.json', directory));
  const witnesses = json('formal/catalogs/coverage-witnesses.json', directory);
  const implementations = registry.implementations ?? [];
  const lines = ['# Conformance profiles', '',
    'Generated by `node formal/tools/generate-catalog-docs.mjs --write` from',
    '[profiles.json](../catalogs/profiles.json), [execution.json](../catalogs/execution.json),',
    '[coverage-witnesses.json](../catalogs/coverage-witnesses.json), the replay descriptors under',
    '[../replay/](../replay/README.md) (the fixture and setup through `bindings.mjs`, the shared record',
    'through `observation.mjs`) and the public runs of each Quint model, which are its replayed',
    'regressions. Do not edit; `make audit` fails when this page is stale.', '',
    'One section per profile: what the drivers are configured with, which commands each recorded',
    'action decodes into, and which observation channels the coordinator compares. A choice is the',
    'integer the Quint action records in `input.choice`; the driver command is what the coordinator',
    'sends for it. [BEHAVIOR.md](../guides/BEHAVIOR.md) explains the scenario format, the fixture',
    'fields and the observation record; [PORTING.md](../guides/PORTING.md) explains what a driver does with them.', ''];
  lines.push('| Profile | Model | Actions | Sampled histories | Replayed regressions | Required witnesses |', '| --- | --- | --- | --- | --- | --- |');
  const rows = registry.profiles.map(profile => {
    const model = execution.models.find(entry => entry.profile === profile.id);
    const description = describeProfile(profile.id);
    return { profile, model, description };
  });
  for (const { profile, model, description } of rows) {
    lines.push(`| [${profile.id}](#${profile.id.replace(/[^a-z0-9-]/g, '')}) | [${profile.model.split('/').pop()}](../models/${profile.model.split('/').pop()}) | ${Object.keys(description.actions).length} | ${model?.generate?.traces ?? '-'} | ${model?.replayRegressions?.length ?? 0} | ${(witnesses[profile.id] ?? []).length} |`);
  }
  lines.push('');
  for (const { profile, model, description } of rows) {
    const claims = implementations.filter(port => port.profiles.includes(profile.id)).map(port => port.id);
    lines.push(`## ${profile.id}`, '', '| | |', '| --- | --- |',
      `| Model | [${profile.model}](../models/${profile.model.split('/').pop()}) |`,
      `| Version | ${profile.version}, inputs \`${profile.inputEncoding}\` |`,
      `| Smoke trace | [${profile.smoke.split('/').pop()}](./${profile.smoke.split('/').pop()}) |`,
      `| Ports claiming it | ${claims.join(', ') || 'none'} |`,
      `| Generation | ${model ? `${model.generate.traces} sampled histories of at most ${model.generate.maxSteps} steps from ${model.generate.maxSamples} samples; ${model.invariants.length} scheduled invariants; ${model.replayRegressions?.length ?? 0} exported regressions` : 'not scheduled'} |`,
      `| Required witnesses | ${(witnesses[profile.id] ?? []).length} labels in [coverage-witnesses.json](../catalogs/coverage-witnesses.json) |`, '');
    const initChoices = description.initChoices ?? [undefined];
    const fixtures = initChoices.map(choice => ({ choice, fixture: description.fixture(choice), setup: description.setup(choice) }));
    const varies = key => new Set(fixtures.map(entry => JSON.stringify(entry[key]))).size > 1;
    if (varies('fixture')) {
      lines.push('### Fixture, by init choice', '', '| Init choice | Fixture |', '| --- | --- |');
      for (const entry of fixtures) lines.push(`| ${entry.choice} | ${text(code(entry.fixture))} |`);
      lines.push('');
    } else {
      lines.push('### Fixture', '', Object.keys(fixtures[0].fixture ?? {}).length ? text(code(fixtures[0].fixture)) : `The coordinator sends an empty fixture; see [${description.kind}.mjs](../replay/${description.kind}.mjs) for what the driver constructs.`, '');
    }
    if (varies('setup')) {
      lines.push('### Setup commands, by init choice', '', '| Init choice | Setup |', '| --- | --- |');
      for (const entry of fixtures) lines.push(`| ${entry.choice} | ${entry.setup.map(command => text(code(command))).join('<br>')} |`);
      lines.push('');
    } else if (fixtures[0].setup.length) lines.push('### Setup commands', '', ...fixtures[0].setup.map(command => `- ${text(code(command))}`), '');
    lines.push('### Actions', '', '| Action | Choices | Driver commands |', '| --- | --- | --- |');
    for (const [name, action] of Object.entries(description.actions)) lines.push(renderAction(profile.id, name, action));
    lines.push('', '### Observation channels', '');
    for (const channel of description.channels) lines.push(`- \`${channel.name}\`: ${channel.fields.map(field => `\`${field}\``).join(', ')}; ${channel.note}.`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

// The two catalog indexes: one row per challenge and per mutant, enough to
// skim and to link from a review; the entry itself is read on demand with
// `node formal/tools/where.mjs <id>`, not mirrored here.
export function renderChallenges({ directory = root } = {}) {
  const challenges = json('formal/catalogs/execution.json', directory).challenges ?? [];
  const lines = ['# Model-fault challenges', '',
    'Generated by `node formal/tools/generate-catalog-docs.mjs --write` from the `challenges` of',
    '[execution.json](../catalogs/execution.json); `make audit` fails when this index is stale. A challenge is',
    'one compiling single-site edit of a Quint source that a named invariant must detect; its native mutant',
    'is the matching edit of the ports in [MUTANTS.md](./MUTANTS.md), or the reason no port line',
    'corresponds. `node formal/tools/where.mjs <challenge>` prints an entry in full (edit, mapping, reproducer,',
    'profile partition with exclusion reasons); [AUTHORING.md](../guides/AUTHORING.md#challenging-every-model)',
    'explains what a challenge measures.', '',
    '| Challenge | Contract | Source | Invariant | Native mutant | Reproducer run | Detected / excluded |',
    '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const c of challenges) {
    const native = c.nativeMutants ?? {}, r = c.reproducer ?? {};
    const detected = (r.profiles ?? []).filter(p => !p.includes('/')).length, excluded = Object.keys(r.exclusions ?? {}).length;
    lines.push(`| \`${text(c.id)}\` | ${text(c.contract ?? '-')} | ${text(c.source.replace(/^formal\/models\//, ''))} | \`${text(c.invariant)}\` | ${text(native.kind)}${native.mutant ? ` \`${text(native.mutant)}\`` : ''}${native.crossContract ? ' (cross-contract)' : ''} | ${r.run ? `\`${text(r.run)}\`` : '-'} | ${detected} / ${excluded} |`);
  }
  return lines.join('\n') + '\n';
}

export function renderMutants({ directory = root } = {}) {
  const mutants = json('formal/catalogs/mutations.json', directory).mutations ?? [];
  const rust = new Map((json('formal/catalogs/rust-mutations.json', directory).mutations ?? []).map(m => [m.typescriptMutation ?? m.id, m]));
  const mappedBy = new Map();
  for (const c of json('formal/catalogs/execution.json', directory).challenges ?? []) if (c.nativeMutants?.mutant) mappedBy.set(c.nativeMutants.mutant, [...(mappedBy.get(c.nativeMutants.mutant) ?? []), c.id]);
  const detections = spec => spec?.requiredDetections?.length ? text(spec.requiredDetections.join(', ')) : '-';
  const lines = ['# Native mutants', '',
    'Generated by `node formal/tools/generate-catalog-docs.mjs --write` from',
    '[mutations.json](../catalogs/mutations.json) (TypeScript and Go) and',
    '[rust-mutations.json](../catalogs/rust-mutations.json); `make audit` fails when this index is stale. A native',
    'mutant is one described fault injected into each port by anchored edits, with the detections each cohort',
    'must record (`ordinary` tests, the `generated` corpus, the `fixed` scenarios and vectors, the `portable`',
    'union of fixed and generated). `node formal/tools/where.mjs M01` prints an entry in full (rationale, edits',
    'per port, detections, the challenges mapped to it);',
    '[AUTHORING.md](../guides/AUTHORING.md#mapping-every-challenge-to-native-mutants) explains the lanes.', '',
    '| Mutant | Case | Description | TypeScript | Go | Rust | Challenges mapped |',
    '| --- | --- | --- | --- | --- | --- | --- |'];
  for (const m of mutants) lines.push(`| \`${text(m.id)}\` | ${text(m.case)} | ${text(m.description)} | ${detections(m.typescript)} | ${detections(m.go)} | ${detections(rust.get(m.id))} | ${(mappedBy.get(m.id) ?? []).map(id => `\`${text(id)}\``).join(', ') || 'none'} |`);
  return lines.join('\n') + '\n';
}

const renderers = { profiles: renderProfiles, challenges: renderChallenges, mutants: renderMutants };

export function checkCatalogDocs({ directory = root } = {}) {
  const stale = [];
  for (const [name, path] of Object.entries(views)) {
    const rendered = renderers[name]({ directory });
    let committed;
    try { committed = readFileSync(resolve(directory, path), 'utf8'); } catch { committed = undefined; }
    if (committed !== rendered) stale.push(path);
  }
  if (stale.length) throw new Error(`Generated views are stale; run node formal/tools/generate-catalog-docs.mjs --write: ${stale.join(', ')}`);
  return { views: Object.keys(views).length };
}

export function writeCatalogDocs({ directory = root } = {}) {
  for (const [name, path] of Object.entries(views)) writeFileSync(resolve(directory, path), renderers[name]({ directory }));
  return { views: Object.keys(views).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--write', '--check'].includes(mode)) {
    console.error('Usage: node formal/tools/generate-catalog-docs.mjs --write|--check');
    process.exitCode = 2;
  } else console.log(mode === '--write' ? writeCatalogDocs() : checkCatalogDocs());
}
