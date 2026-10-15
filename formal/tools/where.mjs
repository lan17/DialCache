// Where a contract lives, from the catalogs the audit already parses. For one
// contract ID (C45), one semantic case (C45.recheck-after-decode) or one native
// case (B01.registration-and-policy-snapshot) it prints where the obligation is
// stated (its CONTRACTS row and every model comment that cites it, ranges such
// as "C40 to C46" included), tested (the semantic cases that carry it with
// their scenarios, scoped Quint checks, witnesses, replays, vectors, defining
// transitions and source pointers; the native cases that carry it with their
// port tests; the documentation sections and tests disposed to it; the feature
// families), challenged (the model-fault challenges that name it) and mapped
// (the native mutants whose case carries it and the Go parity rows). No new
// data and no gate: this is the navigation a reviewer or an agent otherwise
// assembles by hand.
//
// For one model-fault challenge (recovery-inclusive-maximum) or one native
// mutant (M01) it prints the entry in full: the edit, the invariant, the
// mapping, the reproducer and the profile partition, or the rationale, the
// edits per port and the required detections. The generated index tables under
// formal/generated/ list the IDs.
//
//   node formal/tools/where.mjs C45 [--json]
//   node formal/tools/where.mjs recovery-inclusive-maximum
//   node formal/tools/where.mjs M01
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path, directory) => readFileSync(resolve(directory, path), 'utf8');
const json = (path, directory) => JSON.parse(read(path, directory));

// The scheduled models and the kernel: the sources whose comments state
// rules. The kernel fixtures exercise seams and are not scanned.
function modelFiles(directory) {
  const walk = relative => readdirSync(resolve(directory, relative), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? (entry.name === 'fixtures' ? [] : walk(`${relative}/${entry.name}`)) : entry.name.endsWith('.qnt') ? [`${relative}/${entry.name}`] : []);
  return walk('formal/models').sort();
}

// Does a comment line cite the ID? A citation is the ID as a whole token, or a
// range of the same letter that contains it: "C40-C46", "C40 to C46".
export function cites(line, id) {
  const letter = id[0], number = Number(id.slice(1));
  for (const match of line.matchAll(/\b([CWEBX])(\d{2})(?:\s*(?:-|to)\s*([CWEBX])(\d{2}))?\b/g)) {
    const [, fromLetter, from, toLetter, to] = match;
    if (fromLetter !== letter) continue;
    if (to === undefined) { if (Number(from) === number) return true; continue; }
    if (toLetter === letter && Number(from) <= number && number <= Number(to)) return true;
  }
  return false;
}

function contractRow(id, directory) {
  const rows = read('formal/guides/CONTRACTS.md', directory).split('\n');
  const index = rows.findIndex(line => line.startsWith(`| ${id} |`));
  if (index < 0) throw new Error(`${id}: not a contract in formal/guides/CONTRACTS.md`);
  const cells = rows[index].trim().replace(/^\|\s*|\s*\|$/g, '').split(/\s*\|\s*/);
  if (cells.length !== 3) throw new Error(`formal/guides/CONTRACTS.md:${index + 1}: expected three cells (ID, obligation, evidence), found ${cells.length}`);
  return { line: index + 1, obligation: cells[1], evidence: cells[2] };
}

export function lookup(query, { directory = root } = {}) {
  if (/^M\d{2}$/.test(query ?? '')) return lookupMutant(query, directory);
  if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/.test(query ?? '')) return lookupChallenge(query, directory);
  const match = /^([CWEBX]\d{2})(?:\.([\w-]+))?$/.exec(query ?? '');
  if (!match) throw new Error(`${query}: expected a contract ID such as C45, a semantic case such as C45.recheck-after-decode, a native case such as B01.registration-and-policy-snapshot, a challenge ID such as recovery-inclusive-maximum or a mutant ID such as M01`);
  const [, id, caseName] = match;
  const caseId = caseName ? `${id}.${caseName}` : undefined;
  const row = contractRow(id, directory);
  const quint = modelFiles(directory).flatMap(path => read(path, directory).split('\n').flatMap((line, index) =>
    line.trim().startsWith('//') && cites(line, id) ? [{ path, line: index + 1, text: line.trim().replace(/^\/\/\s?/, '') }] : []));
  const coverage = json('formal/catalogs/feature-coverage.json', directory);
  const semanticAll = json('formal/catalogs/semantic-cases.json', directory).cases.filter(entry => (entry.contracts ?? []).includes(id) || entry.id.startsWith(`${id}.`));
  const nativeAll = (coverage.nativeCases ?? []).filter(entry => (entry.contracts ?? []).includes(id) || entry.id.startsWith(`${id}.`));
  if (caseId && !semanticAll.some(entry => entry.id === caseId) && !nativeAll.some(entry => entry.id === caseId)) {
    throw new Error(`${caseId}: not a semantic case in formal/catalogs/semantic-cases.json nor a native case in formal/catalogs/feature-coverage.json`);
  }
  const semantic = semanticAll.filter(entry => !caseId || entry.id === caseId).map(entry => ({ id: entry.id, rule: entry.rule, scenarios: entry.scenarios ?? [],
    models: (entry.models ?? []).map(model => model.ref), definitions: (entry.definitions ?? []).map(definition => definition.ref), provenance: entry.provenance ?? [],
    witnesses: (entry.generated ?? []).map(item => `${item.profile}/${item.witness}`), replays: entry.quintReplays ?? [], vectors: entry.vectors ?? [],
    generatedVectors: (entry.generatedVectors ?? []).map(item => `${item.artifact}#${item.group ?? 'vectors'}/${item.name}`) }));
  const native = nativeAll.filter(entry => !caseId || entry.id === caseId).map(entry => ({ id: entry.id, rule: entry.rule, related: entry.relatedContracts ?? [],
    tests: ['typescript', 'go'].flatMap(port => (entry[port] ?? []).map(test => `${test.path} "${test.test}"`)), adaptation: entry.adaptation, gaps: entry.gaps ?? [], notApplicable: entry.notApplicable }));
  const caseIds = new Set(semantic.map(entry => entry.id));
  const audit = json('formal/catalogs/source-audit.json', directory);
  const disposed = (audit.sources ?? []).flatMap(source => (source.entries ?? []).filter(entry => (entry.contracts ?? []).includes(id)).map(entry => ({ path: source.path, title: entry.title })));
  const mutantsAll = json('formal/catalogs/mutations.json', directory).mutations ?? [];
  const caseOf = new Map(mutantsAll.map(mutant => [mutant.id, mutant.case]));
  const rust = new Map((json('formal/catalogs/rust-mutations.json', directory).mutations ?? []).map(mutant => [mutant.typescriptMutation ?? mutant.id, mutant]));
  // Under a case query a challenge stays when its mutant sits on that case; a
  // challenge without a port line, or one mapped across contracts, cannot be
  // narrowed and stays with a tag saying so.
  const challenges = (json('formal/catalogs/execution.json', directory).challenges ?? []).filter(challenge => challenge.contract === id).flatMap(challenge => {
    const mutant = challenge.nativeMutants?.mutant, kind = challenge.nativeMutants?.kind, mutantCase = mutant ? caseOf.get(mutant) : undefined;
    let tag;
    if (caseId) {
      if (!mutant) tag = `${kind}, not narrowed to a case`;
      else if (mutantCase !== caseId) { if (!challenge.nativeMutants?.crossContract) return []; tag = `cross-contract via ${mutant} on ${mutantCase}`; }
    } else if (challenge.nativeMutants?.crossContract) tag = `cross-contract via ${mutant} on ${mutantCase}`;
    const profiles = challenge.reproducer?.profiles ?? [];
    return [{ id: challenge.id, source: challenge.source, model: challenge.model, invariant: challenge.invariant, native: kind, mutant, mutantCase, tag,
      crossContract: challenge.nativeMutants?.crossContract, run: challenge.reproducer?.run,
      detectingProfiles: profiles.filter(profile => !profile.includes('/')).length, detectingModels: profiles.filter(profile => profile.includes('/')).length,
      excluded: Object.keys(challenge.reproducer?.exclusions ?? {}).length }];
  });
  const mutants = mutantsAll.filter(mutant => caseIds.has(mutant.case)).map(mutant => ({ id: mutant.id, case: mutant.case, description: mutant.description,
    ports: [mutant.typescript?.edits?.length ? 'typescript' : null, mutant.go?.edits?.length ? 'go' : null, rust.get(mutant.id)?.edits?.length ? 'rust' : null].filter(Boolean) }));
  const parity = (json('formal/catalogs/go-parity.json', directory).cases ?? []).filter(entry => caseIds.has(entry.id))
    .map(entry => ({ id: entry.id, group: entry.group, gaps: entry.gaps ?? [], nativeGo: entry.evidence?.nativeGo ?? [] }));
  const features = (coverage.features ?? []).filter(feature => (feature.contracts ?? []).includes(id) || (feature.cases ?? []).some(entry => caseIds.has(entry)) || (feature.nativeCases ?? []).some(entry => native.some(item => item.id === entry)))
    .map(feature => ({ id: feature.id, title: feature.title }));
  const rule = semantic.find(entry => entry.id === caseId)?.rule ?? native.find(entry => entry.id === caseId)?.rule ?? null;
  return { id, case: caseId ?? null, caseRule: rule, obligation: row.obligation, evidence: row.evidence, contractsLine: row.line, quint, cases: semantic, nativeCases: native, disposed, challenges, mutants, parity, features };
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function lookupChallenge(id, directory) {
  const challenge = (json('formal/catalogs/execution.json', directory).challenges ?? []).find(entry => entry.id === id);
  if (!challenge) throw new Error(`${id}: not a challenge in formal/catalogs/execution.json`);
  const mutants = json('formal/catalogs/mutations.json', directory).mutations ?? [];
  const mutant = challenge.nativeMutants?.mutant ? mutants.find(entry => entry.id === challenge.nativeMutants.mutant) : undefined;
  return { kind: 'challenge', ...challenge, mutantCase: mutant?.case };
}

function lookupMutant(id, directory) {
  const mutant = (json('formal/catalogs/mutations.json', directory).mutations ?? []).find(entry => entry.id === id);
  if (!mutant) throw new Error(`${id}: not a mutant in formal/catalogs/mutations.json`);
  const rust = (json('formal/catalogs/rust-mutations.json', directory).mutations ?? []).find(entry => (entry.typescriptMutation ?? entry.id) === id);
  const challenges = (json('formal/catalogs/execution.json', directory).challenges ?? []).filter(entry => entry.nativeMutants?.mutant === id).map(entry => entry.id);
  return { kind: 'mutant', ...mutant, rust, challenges };
}

const block = text => String(text).split('\n').map(line => `    ${line}`).join('\n');

function renderChallenge(c) {
  const lines = [`${c.id}: challenge on ${c.contract}, ${c.source} under ${c.model}:${c.invariant}`, ''];
  lines.push('Edit', '  before:', block(c.before), '  after:', block(c.after), '');
  const native = c.nativeMutants ?? {};
  lines.push(`Native mutant: ${native.kind}${native.mutant ? ` ${native.mutant}${c.mutantCase ? ` (${c.mutantCase})` : ''}` : ''}`);
  if (native.text) lines.push(block(native.text));
  if (native.crossContract) lines.push('  cross-contract:', block(native.crossContract));
  if (native.evidence) lines.push(`  evidence checkpoint: ${JSON.stringify(native.evidence)}`);
  if (c.measures) lines.push('', 'Measures', block(c.measures));
  const r = c.reproducer ?? {};
  lines.push('', `Reproducer${r.kind ? ` (${r.kind})` : ''}`);
  if (r.run) lines.push(`  run ${r.run} in ${r.model ?? c.model}`);
  if (r.family) lines.push(`  family ${r.family}`);
  if (r.scope) lines.push('  scope:', block(r.scope));
  if (r.failure) lines.push('  expected failure under the fault:', block(r.failure));
  const profiles = r.profiles ?? [];
  lines.push('', `Detected by ${plural(profiles.filter(p => !p.includes('/')).length, 'profile')}${profiles.some(p => p.includes('/')) ? ` and ${plural(profiles.filter(p => p.includes('/')).length, 'model')}` : ''}: ${profiles.join(', ') || 'none'}`);
  const exclusions = Object.entries(r.exclusions ?? {});
  lines.push('', `Excluded (${exclusions.length})`);
  for (const [profile, reason] of exclusions) lines.push(`  ${profile}: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
  return lines.join('\n') + '\n';
}

function renderMutant(m) {
  const lines = [`${m.id}: ${m.description} (case ${m.case})`, ''];
  if (m.rationale) lines.push('Rationale', block(m.rationale), '');
  for (const [port, spec] of [['TypeScript', m.typescript], ['Go', m.go], ['Rust', m.rust]]) {
    if (!spec?.edits?.length) continue;
    lines.push(`${port}: required detections ${spec.requiredDetections?.join(', ') || 'none'}`);
    for (const edit of spec.edits) lines.push(`  ${edit.path}`, '    before:', block(edit.before).replace(/^/gm, '  '), '    after:', block(edit.after).replace(/^/gm, '  '));
    lines.push('');
  }
  lines.push(`Challenges mapped to it: ${m.challenges.join(', ') || 'none'}`);
  return lines.join('\n') + '\n';
}

export function render(result) {
  if (result.kind === 'challenge') return renderChallenge(result);
  if (result.kind === 'mutant') return renderMutant(result);
  const lines = [result.case ? `${result.case}: ${result.caseRule}` : `${result.id}: ${result.obligation}`, ''];
  if (result.case) lines.push(`Contract ${result.id}: ${result.obligation}`, '');
  lines.push('Stated', `  formal/guides/CONTRACTS.md:${result.contractsLine}  (evidence column: ${result.evidence})`);
  for (const cite of result.quint) lines.push(`  ${cite.path}:${cite.line}  ${cite.text}`);
  lines.push('', `Tested (${plural(result.cases.length, 'semantic case')}${result.nativeCases.length ? `, ${plural(result.nativeCases.length, 'native case')}` : ''})`);
  for (const entry of result.cases) {
    lines.push(`  ${entry.id}: ${entry.rule}`);
    if (entry.scenarios.length) lines.push(`    scenarios: ${entry.scenarios.map(s => `"${s}"`).join(', ')}`);
    if (entry.models.length) lines.push(`    quint checks: ${entry.models.join(', ')}`);
    if (entry.definitions.length) lines.push(`    defining transitions: ${entry.definitions.join(', ')}`);
    if (entry.witnesses.length) lines.push(`    witnesses: ${entry.witnesses.join(', ')}`);
    if (entry.replays.length) lines.push(`    replays: ${entry.replays.join(', ')}`);
    if (entry.vectors.length) lines.push(`    vectors: ${entry.vectors.join(', ')}`);
    if (entry.generatedVectors.length) lines.push(`    generated vectors: ${entry.generatedVectors.join(', ')}`);
    if (entry.provenance.length) lines.push(`    source: ${entry.provenance.join(', ')}`);
  }
  for (const entry of result.nativeCases) {
    lines.push(`  ${entry.id}: ${entry.rule}${entry.related.length ? ` (related ${entry.related.join(', ')})` : ''}`);
    if (entry.tests.length) lines.push(`    tests: ${entry.tests.join('; ')}`);
    if (entry.adaptation) lines.push(`    adaptation: ${entry.adaptation}`);
    if (entry.notApplicable) lines.push(`    not applicable: ${typeof entry.notApplicable === 'string' ? entry.notApplicable : JSON.stringify(entry.notApplicable)}`);
    if (entry.gaps.length) lines.push(`    gaps: ${entry.gaps.map(gap => typeof gap === 'string' ? gap : JSON.stringify(gap)).join('; ')}`);
  }
  if (result.disposed.length) { lines.push('  disposed sections and tests (source-audit.json):'); for (const item of result.disposed) lines.push(`    ${item.path}  "${item.title}"`); }
  if (result.features.length) lines.push(`  feature families: ${result.features.map(f => `${f.id} (${f.title})`).join('; ')}`);
  lines.push('', `Challenged (${plural(result.challenges.length, 'challenge')})`);
  for (const challenge of result.challenges) {
    lines.push(`  ${challenge.id}: ${challenge.source ?? '?'} under ${challenge.model ?? '?'}:${challenge.invariant}; native ${challenge.native}${challenge.mutant ? ` ${challenge.mutant}` : ''}${challenge.run ? `; reproducer ${challenge.run}` : ''}; detected by ${plural(challenge.detectingProfiles, 'profile')}${challenge.detectingModels ? ` and ${plural(challenge.detectingModels, 'model')}` : ''}, ${challenge.excluded} excluded${challenge.tag ? ` [${challenge.tag}]` : ''}`);
    if (challenge.crossContract) lines.push(`    cross-contract: ${challenge.crossContract}`);
  }
  lines.push('', `Mapped (${plural(result.mutants.length, 'native mutant')})`);
  for (const mutant of result.mutants) lines.push(`  ${mutant.id} (${mutant.case}): ${mutant.description}; edits in ${mutant.ports.join(', ') || 'no port'}`);
  for (const row of result.parity) lines.push(`  go-parity ${row.id}: group ${row.group}${row.gaps.length ? `; gaps ${row.gaps.length}` : ''}${row.nativeGo.length ? `; native Go ${row.nativeGo.join(', ')}` : ''}`);
  return lines.join('\n') + '\n';
}

export function parseArguments(args) {
  const flags = args.filter(arg => arg.startsWith('--')), positional = args.filter(arg => !arg.startsWith('--'));
  const unknown = flags.filter(flag => flag !== '--json');
  if (positional.length !== 1 || unknown.length) throw new Error('Usage: node formal/tools/where.mjs <contract, case, challenge or mutant: C45, C45.recheck-after-decode, B01.registration-and-policy-snapshot, recovery-inclusive-maximum, M01> [--json]');
  return { query: positional[0], json: flags.includes('--json') };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let parsed;
  try { parsed = parseArguments(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 2; }
  if (parsed) {
    try {
      const result = lookup(parsed.query);
      process.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : render(result));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
