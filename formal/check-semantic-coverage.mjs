import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkSourceAudit } from './check-source-audit.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(root + path, 'utf8');
const parse = path => JSON.parse(read(path));
const contractIds = [...read('formal/CONTRACTS.md').matchAll(/^\| ([CW]\d{2}) \|/gm)].map(m => m[1]);
const scenarios = new Set(parse('formal/behavioral-scenarios.json').scenarios.map(s => s.name));
const witnesses = parse('formal/coverage-witnesses.json');
const protocol = parse('formal/protocol-vectors.json');
const invalidation = parse('formal/invalidation-vectors.json').vectors;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function checkProfiles(registry = parse('formal/profiles.json')) {
  if (registry.schemaVersion !== 1 || registry.specificationVersion !== '0.1.0' || registry.status !== 'experimental') throw new Error('Unsupported specification/profile registry');
  if (registry.behavioralSchemaVersion !== parse('formal/behavioral-scenarios.json').schemaVersion ||
    registry.protocolSchemaVersion !== protocol.schemaVersion || registry.invalidationSchemaVersion !== parse('formal/invalidation-vectors.json').schemaVersion) throw new Error('Profile registry schema versions have drifted');
  const expected = ['admission', 'core', 'effects', 'independent', 'layers', 'policy', 'recovery', 'scope', 'shadow'];
  if (!Array.isArray(registry.profiles) || JSON.stringify(registry.profiles.map(p => p.id).sort()) !== JSON.stringify(expected)) throw new Error('Profile inventory changed; review claims');
  read(registry.normativeDefinition);
  for (const profile of registry.profiles) {
    if (profile.version !== 1) throw new Error(`${profile.id}: unsupported profile version`);
    read(profile.definition); read(profile.model);
    const smoke = parse(profile.smoke);
    if (!Array.isArray(smoke.states) || !smoke.states.length) throw new Error(`${profile.id}: missing smoke evidence`);
    for (const id of profile.historyContracts ?? []) if (!contractIds.includes(id)) throw new Error(`${profile.id}: unknown history contract`);
  }
  for (const implementation of registry.implementations) {
    if (!Array.isArray(implementation.profiles) || implementation.profiles.some(id => !expected.includes(id)) || !implementation.limits) throw new Error('Unsupported implementation claim');
    if (implementation.definition) read(implementation.definition);
  }
  return { specificationVersion: registry.specificationVersion, profiles: expected.length };
}

export function checkSemanticCoverage(catalog = parse('formal/semantic-cases.json')) {
  const profiles = checkProfiles();
  const sourceAccounting = checkSourceAudit();
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.cases) || !catalog.cases.length) throw new Error('Invalid semantic case inventory');
  const ids = new Set(), parents = new Set();
  for (const [profile, names] of Object.entries(witnesses)) {
    if (!Array.isArray(names) || !names.length || names.some(n => typeof n !== 'string' || !n) || new Set(names).size !== names.length) throw new Error(`Invalid witness catalog: ${profile}`);
  }
  for (const c of catalog.cases) {
    if (!/^[CW]\d{2}\.[a-z0-9-]+$/.test(c.id) || ids.has(c.id)) throw new Error(`Invalid/duplicate case: ${c.id}`);
    ids.add(c.id);
    if (!Array.isArray(c.contracts) || !c.contracts.includes(c.id.split('.')[0]) || c.contracts.some(id => !contractIds.includes(id))) throw new Error(`${c.id}: unknown/missing contract`);
    c.contracts.forEach(id => parents.add(id));
    if (typeof c.rule !== 'string' || c.rule.length < 10) throw new Error(`${c.id}: missing rule`);
    for (const key of ['scenarios', 'generated', 'models', 'vectors']) if (!Array.isArray(c[key])) throw new Error(`${c.id}: missing evidence list ${key}`);
    for (const name of c.scenarios) if (!scenarios.has(name)) throw new Error(`${c.id}: unknown scenario ${name}`);
    for (const g of c.generated) if (!witnesses[g.profile]?.includes(g.witness)) throw new Error(`${c.id}: unknown required witness ${g.profile}/${g.witness}`);
    for (const model of c.models) {
      const [path, name] = model.split(':');
      if (!/^formal\/[\w-]+\.qnt$/.test(path) || !name || !new RegExp(`\\b(?:val|run) ${escapeRegex(name)}\\b`).test(read(path))) throw new Error(`${c.id}: missing model property ${model}`);
    }
    for (const vector of c.vectors) {
      const parts = vector.split('/');
      const entries = parts[0] === 'protocol' ? protocol[parts[1]] : parts[0] === 'invalidation' ? invalidation : undefined;
      const name = parts[0] === 'protocol' ? parts.slice(2).join('/') : parts.slice(1).join('/');
      if (!Array.isArray(entries) || !entries.length || (name !== '*' && !entries.some(v => v.name === name))) throw new Error(`${c.id}: unknown vector ${vector}`);
    }
    const executable = c.scenarios.length + c.generated.length + c.models.length + c.vectors.length;
    if (!executable && (typeof c.gap !== 'string' || c.gap.length < 10)) throw new Error(`${c.id}: uncovered case needs an explicit gap`);
  }
  if (contractIds.some(id => !parents.has(id))) throw new Error('Portable contract missing from case inventory');
  const mutations = parse('formal/semantic-mutations.json');
  if (mutations.schemaVersion !== 1 || !Array.isArray(mutations.mutations) || !mutations.mutations.length) throw new Error('Invalid mutation catalog');
  const mutationIds = new Set();
  for (const m of mutations.mutations) {
    if (!/^M\d+$/.test(m.id) || mutationIds.has(m.id) || !ids.has(m.case)) throw new Error(`Invalid mutation case/ID: ${m.id}`);
    mutationIds.add(m.id);
    if (!Array.isArray(m.requiredDetections) || m.requiredDetections.some(c => !['ordinary', 'generated', 'portable'].includes(c))) throw new Error(`${m.id}: unknown mutation cohort`);
  }
  const behavioral = catalog.cases.filter(c => !c.vectors.length);
  const portable = c => c.scenarios.length || c.generated.length || c.vectors.length;
  const count = cases => ({ total: cases.length, model: cases.filter(c => c.models.length).length,
    portable: cases.filter(portable).length, generated: cases.filter(c => c.generated.length).length,
    modelOnly: cases.filter(c => c.models.length && !portable(c)).map(c => c.id),
    uncovered: cases.filter(c => !c.models.length && !portable(c)).map(c => c.id) });
  return { profiles, sourceAccounting, contracts: parents.size, cases: count(catalog.cases), behavioral: count(behavioral),
    protocol: count(catalog.cases.filter(c => c.vectors.length)), mutations: mutations.mutations.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(process.argv.includes('--profiles-stdin')
    ? checkProfiles(JSON.parse(readFileSync(0, 'utf8')))
    : checkSemanticCoverage(process.argv.includes('--stdin') ? JSON.parse(readFileSync(0, 'utf8')) : undefined), null, 2));
}
