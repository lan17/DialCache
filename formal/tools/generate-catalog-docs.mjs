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
import { effectsDescriptor, fixtureFor as effectsFixture, inputsFor as effectsInputs, observedFields as effectsObservedFields } from '../replay/effects.mjs';
import { localClockDescriptor, localClockInput } from '../replay/local-clock.mjs';
import { actionNames as coreActionNames, coreCommands, observationFields as coreObservationFields } from '../replay/core.mjs';
import { emptyObservation } from '../replay/observation.mjs';
import { readExecution, scheduleExecution } from './execution.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const views = { profiles: 'formal/generated/PROFILES.md' };
const json = (path, directory = root) => JSON.parse(readFileSync(resolve(directory, path), 'utf8'));
const code = value => `\`${JSON.stringify(value)}\``;
const text = value => String(value).replaceAll('|', '\\|');

// The replay descriptor of each profile, in one shape: fixture (a value or a
// function of the init choice), setup commands, and actions, each decoding a
// recorded choice into the driver commands for that step.
export function describeProfile(id) {
  if (id === 'core') {
    return { kind: 'core', fixture: undefined, setup: [], initChoices: undefined,
      actions: Object.fromEntries(coreActionNames.filter(name => name !== 'init').map(name => [name, { decode: () => coreCommands(name) }])),
      channels: [{ name: 'o', fields: coreObservationFields, note: 'the model fields observable through the public API' }] };
  }
  if (id === 'effects') {
    const descriptor = effectsDescriptor;
    return { kind: 'effects', fixture: mode => effectsFixture(mode), initChoices: [0, 1, 2, 3, 4, 5], setup: [],
      actions: Object.fromEntries(Object.entries(descriptor.actions).map(([name, action]) => [name,
        { choices: action.choices, decode: (choice, observed, environment) => effectsInputs({ action: name, choice }, observed, environment) }])),
      channels: [{ name: 'o', fields: [...effectsObservedFields, 'calls', 'events', 'readContexts', 'readAborts'], note: 'the effects record: counters, caller codes, the ordered event trail, read contexts and aborts' }] };
  }
  if (id === 'local-clock') {
    return { kind: 'local-clock', fixture: undefined, setup: [], initChoices: undefined,
      actions: Object.fromEntries(Object.entries(localClockDescriptor.actions).map(([name, action]) => [name, { choices: action.choices, decode: choice => localClockInput(name, choice) }])),
      channels: [{ name: 'o', fields: Object.keys(emptyObservation()), note: 'the shared observation record' }] };
  }
  const descriptor = featureProfiles[id];
  if (!descriptor) throw new Error(`No replay descriptor for profile ${id}`);
  const channels = [{ name: 'o', fields: Object.keys(emptyObservation()), note: 'the shared observation record' }];
  if (descriptor.readIO) channels.push({ name: 'io', fields: ['budgets', 'aborted', 'sourceErrors'], note: 'read budgets in dispatch order, aborted read indices, each caller\'s source-error identity' });
  if (descriptor.diagnosticAge !== undefined) channels.push({ name: 'd', fields: ['ages', 'coalesced', 'fallbackErrors', 'warnings', ...(descriptor.diagnosticConfigErrors ? ['configErrors'] : []), ...(descriptor.diagnosticFutureOffsets ? ['futureOffsets'] : []), ...(descriptor.diagnosticInspections ? ['inspections'] : [])], note: `diagnostics; ages are the \`${descriptor.diagnosticAge}\` events` });
  if (descriptor.markerIO) channels.push({ name: 'markers', fields: ['cutoffMs', 'ttlMs'], note: 'one record per observed invalidation marker' });
  if (descriptor.compressionIO) channels.push({ name: 'compression', fields: ['decompressed', 'fallback_raw'], note: 'one outcome per decode' });
  if (descriptor.policyErrorIO) channels.push({ name: 'policyErrors', fields: ['layer', 'errorType'], note: 'one record per configuration error' });
  return { kind: 'features', fixture: descriptor.fixture, initChoices: descriptor.initChoices, setup: descriptor.setup ?? [],
    actions: Object.fromEntries(Object.entries(descriptor.actions).map(([name, action]) => [name, { choices: action.choices, decode: (choice, observed, environment) => action.input(choice, observed, environment) }])),
    channels };
}

// Decode a choice with probes standing in for the observation and the
// environment: every counter reads as 1, the wall clock as 0, and the keys a
// decoder touches are reported, so the page can say "from the observation".
export function decodeWithProbes(decode, choice) {
  const touched = new Set();
  const observed = new Proxy({}, { get: (_, key) => { if (typeof key === 'string') touched.add(`observation.${key}`); return key === 'events' || key === 'calls' ? [] : 1; } });
  const environment = new Proxy({}, { get: (_, key) => { if (typeof key === 'string') touched.add(`environment.${key}`); return 0; } });
  const input = decode(choice, observed, environment);
  return { input, touched: [...touched] };
}

const range = choices => {
  if (choices === 'index') return 'any effect or loader index';
  if (!choices?.length) return 'none';
  const contiguous = choices.every((value, index) => index === 0 || value === choices[index - 1] + 1);
  return contiguous && choices.length > 2 ? `${choices[0]}..${choices.at(-1)}` : choices.join(', ');
};
const collapse = fn => String(fn).replace(/\s+/g, ' ').trim();

function renderAction(name, action) {
  const choices = action.choices === 'index' ? [0] : action.choices ?? [undefined];
  const examples = choices.map(choice => ({ choice, ...decodeWithProbes(action.decode, choice) }));
  const touched = [...new Set(examples.flatMap(example => example.touched))];
  const show = example => example.choice === undefined ? code(example.input) : `${example.choice} → ${code(example.input)}`;
  let cell;
  if (examples.length <= 12) cell = examples.map(show).join('<br>');
  else cell = [...examples.slice(0, 6).map(show), '…', ...examples.slice(-2).map(show)].join('<br>');
  if (touched.length) cell += `<br>${touched.map(key => `\`${key}\``).join(', ')} read at the step; the example assumes one so far`;
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
    '[coverage-witnesses.json](../catalogs/coverage-witnesses.json) and the replay descriptors under',
    '[../replay/](../replay/README.md). Do not edit; `make audit` fails when this page is stale.', '',
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
    if (typeof description.fixture === 'function') {
      lines.push('### Fixture, by init choice', '', '| Init choice | Fixture |', '| --- | --- |');
      for (const choice of description.initChoices ?? [0]) lines.push(`| ${choice} | ${text(code(description.fixture(choice)))} |`);
      lines.push('');
    } else if (description.fixture !== undefined) {
      lines.push('### Fixture', '', text(code(description.fixture)), '');
    } else if (description.kind === 'core') {
      lines.push('### Fixture', '', 'The core profile uses the fixed fixture of [core.mjs](../replay/core.mjs); its actions carry no choice.', '');
    } else {
      lines.push('### Fixture', '', 'The local-clock profile constructs real default instances; see [local-clock.mjs](../replay/local-clock.mjs).', '');
    }
    if (description.setup.length) lines.push('### Setup commands', '', ...description.setup.map(command => `- ${text(code(command))}`), '');
    lines.push('### Actions', '', '| Action | Choices | Driver commands |', '| --- | --- | --- |');
    for (const [name, action] of Object.entries(description.actions)) lines.push(renderAction(name, action));
    lines.push('', '### Observation channels', '');
    for (const channel of description.channels) lines.push(`- \`${channel.name}\`: ${channel.fields.map(field => `\`${field}\``).join(', ')}; ${channel.note}.`);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

export function checkCatalogDocs({ directory = root } = {}) {
  const stale = [];
  for (const [name, path] of Object.entries(views)) {
    const rendered = name === 'profiles' ? renderProfiles({ directory }) : undefined;
    let committed;
    try { committed = readFileSync(resolve(directory, path), 'utf8'); } catch { committed = undefined; }
    if (committed !== rendered) stale.push(path);
  }
  if (stale.length) throw new Error(`Generated views are stale; run node formal/tools/generate-catalog-docs.mjs --write: ${stale.join(', ')}`);
  return { views: Object.keys(views).length };
}

export function writeCatalogDocs({ directory = root } = {}) {
  writeFileSync(resolve(directory, views.profiles), renderProfiles({ directory }));
  return { views: Object.keys(views).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (process.argv.length !== 3 || !['--write', '--check'].includes(mode)) {
    console.error('Usage: node formal/tools/generate-catalog-docs.mjs --write|--check');
    process.exitCode = 2;
  } else console.log(mode === '--write' ? writeCatalogDocs() : checkCatalogDocs());
}
