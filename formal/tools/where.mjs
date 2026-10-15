// Where a contract lives, from the catalogs the audit already parses. For one
// contract ID (C45) or one semantic case (C45.recheck-after-decode) it prints
// where the obligation is stated (its CONTRACTS row and every Quint comment
// that cites it), tested (the semantic cases that carry it with their
// scenarios, scoped Quint checks, witnesses, replays and vectors, and the
// documentation sections and tests disposed to it), challenged (the model
// fault challenges that name it) and mapped (the native mutants whose case
// carries it and the Go parity rows). No new data and no gate: this is the
// navigation a reviewer or an agent otherwise assembles by hand.
//
//   node formal/tools/where.mjs C45 [--json]
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path, directory) => readFileSync(resolve(directory, path), 'utf8');
const json = (path, directory) => JSON.parse(read(path, directory));

function quintFiles(directory) {
  const walk = relative => readdirSync(resolve(directory, relative), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${relative}/${entry.name}`) : entry.name.endsWith('.qnt') ? [`${relative}/${entry.name}`] : []);
  return walk('formal/models').sort();
}

export function lookup(query, { directory = root } = {}) {
  const match = /^([CWEBX]\d{2})(?:\.([\w-]+))?$/.exec(query ?? '');
  if (!match) throw new Error(`${query}: expected a contract ID such as C45 or a semantic case such as C45.recheck-after-decode`);
  const [, id, caseName] = match;
  const caseId = caseName ? `${id}.${caseName}` : undefined;
  const row = read('formal/guides/CONTRACTS.md', directory).split('\n').map((line, index) => [line, index + 1]).find(([line]) => line.startsWith(`| ${id} |`));
  if (!row) throw new Error(`${id}: not a contract in formal/guides/CONTRACTS.md`);
  const [, obligation, evidence] = row[0].trim().replace(/^\|\s*|\s*\|$/g, '').split(/\s*\|\s*/);
  // A comment cites the ID when it appears as a whole token: the ID is a letter
  // and two digits, so a neighbouring word character means another ID (C450).
  const cites = line => { let at = line.indexOf(id); while (at >= 0) { const before = line[at - 1], after = line[at + id.length]; if (!/\w/.test(before ?? ' ') && !/\w/.test(after ?? ' ')) return true; at = line.indexOf(id, at + 1); } return false; };
  const quint = quintFiles(directory).flatMap(path => read(path, directory).split('\n').flatMap((line, index) =>
    line.trim().startsWith('//') && cites(line) ? [{ path, line: index + 1, text: line.trim().replace(/^\/\/\s?/, '') }] : []));
  const semantic = json('formal/catalogs/semantic-cases.json', directory).cases
    .filter(entry => caseId ? entry.id === caseId : (entry.contracts ?? []).includes(id) || entry.id.startsWith(`${id}.`))
    .map(entry => ({ id: entry.id, rule: entry.rule, scenarios: entry.scenarios ?? [], models: (entry.models ?? []).map(model => model.ref),
      witnesses: (entry.generated ?? []).map(item => `${item.profile}/${item.witness}`), replays: entry.quintReplays ?? [], vectors: entry.vectors ?? [],
      generatedVectors: (entry.generatedVectors ?? []).map(item => `${item.artifact}#${item.group ?? 'vectors'}/${item.name}`) }));
  if (caseId && semantic.length === 0) throw new Error(`${caseId}: not a semantic case in formal/catalogs/semantic-cases.json`);
  const caseIds = new Set(semantic.map(entry => entry.id));
  const audit = json('formal/catalogs/source-audit.json', directory);
  const disposed = (audit.sources ?? []).flatMap(source => (source.entries ?? []).filter(entry => (entry.contracts ?? []).includes(id)).map(entry => ({ path: source.path, title: entry.title })));
  const guides = (audit.reviewedGuides ?? []).filter(guide => (guide.review?.contracts ?? []).includes(id)).map(guide => guide.path);
  const challenges = (json('formal/catalogs/execution.json', directory).challenges ?? []).filter(challenge => challenge.contract === id)
    .filter(challenge => !caseId || (challenge.nativeMutants?.mutant && mutantCase(challenge.nativeMutants.mutant, directory) === caseId))
    .map(challenge => ({ id: challenge.id, source: challenge.source, model: challenge.model, invariant: challenge.invariant,
      native: challenge.nativeMutants?.kind, mutant: challenge.nativeMutants?.mutant, run: challenge.reproducer?.run,
      detecting: (challenge.reproducer?.profiles ?? []).length, excluded: Object.keys(challenge.reproducer?.exclusions ?? {}).length }));
  const rust = new Map((json('formal/catalogs/rust-mutations.json', directory).mutations ?? []).map(mutant => [mutant.typescriptMutation ?? mutant.id, mutant]));
  const mutants = (json('formal/catalogs/mutations.json', directory).mutations ?? []).filter(mutant => caseId ? mutant.case === caseId : String(mutant.case).startsWith(`${id}.`))
    .map(mutant => ({ id: mutant.id, case: mutant.case, description: mutant.description,
      ports: [mutant.typescript?.edits?.length ? 'typescript' : null, mutant.go?.edits?.length ? 'go' : null, rust.get(mutant.id)?.edits?.length ? 'rust' : null].filter(Boolean) }));
  const parity = (json('formal/catalogs/go-parity.json', directory).cases ?? []).filter(entry => caseIds.has(entry.id))
    .map(entry => ({ id: entry.id, group: entry.group, gaps: entry.gaps ?? [], nativeGo: entry.evidence?.nativeGo ?? [] }));
  const features = (json('formal/catalogs/feature-coverage.json', directory).features ?? []).filter(feature => (feature.contracts ?? []).includes(id) || (feature.cases ?? []).some(entry => caseIds.has(entry)))
    .map(feature => ({ id: feature.id, title: feature.title }));
  return { id, case: caseId, obligation, evidence, contractsLine: row[1], quint, cases: semantic, disposed, guides, challenges, mutants, parity, features };
}

function mutantCase(mutantId, directory) {
  return (json('formal/catalogs/mutations.json', directory).mutations ?? []).find(mutant => mutant.id === mutantId)?.case;
}

export function render(result) {
  const lines = [`${result.case ?? result.id}: ${result.obligation}`, ''];
  lines.push('Stated', `  formal/guides/CONTRACTS.md:${result.contractsLine}  (evidence column: ${result.evidence})`);
  for (const cite of result.quint) lines.push(`  ${cite.path}:${cite.line}  ${cite.text}`);
  if (result.guides.length) lines.push(`  reviewed guides naming it: ${result.guides.join(', ')}`);
  lines.push('', `Tested (${result.cases.length} semantic case${result.cases.length === 1 ? '' : 's'})`);
  for (const entry of result.cases) {
    lines.push(`  ${entry.id}: ${entry.rule}`);
    if (entry.scenarios.length) lines.push(`    scenarios: ${entry.scenarios.map(s => `"${s}"`).join(', ')}`);
    if (entry.models.length) lines.push(`    quint: ${entry.models.join(', ')}`);
    if (entry.witnesses.length) lines.push(`    witnesses: ${entry.witnesses.join(', ')}`);
    if (entry.replays.length) lines.push(`    replays: ${entry.replays.join(', ')}`);
    if (entry.vectors.length) lines.push(`    vectors: ${entry.vectors.join(', ')}`);
    if (entry.generatedVectors.length) lines.push(`    generated vectors: ${entry.generatedVectors.join(', ')}`);
  }
  if (result.disposed.length) { lines.push('  disposed sections and tests (source-audit.json):'); for (const item of result.disposed) lines.push(`    ${item.path}  "${item.title}"`); }
  if (result.features.length) lines.push(`  feature families: ${result.features.map(f => `${f.id} (${f.title})`).join('; ')}`);
  lines.push('', `Challenged (${result.challenges.length} challenge${result.challenges.length === 1 ? '' : 's'})`);
  for (const challenge of result.challenges) {
    lines.push(`  ${challenge.id}: ${challenge.source.split('/').pop()} under ${challenge.model.split('/').pop()}:${challenge.invariant}; native ${challenge.native}${challenge.mutant ? ` ${challenge.mutant}` : ''}${challenge.run ? `; reproducer ${challenge.run}` : ''}; detected by ${challenge.detecting} profiles, ${challenge.excluded} excluded`);
  }
  lines.push('', `Mapped (${result.mutants.length} native mutant${result.mutants.length === 1 ? '' : 's'})`);
  for (const mutant of result.mutants) lines.push(`  ${mutant.id} (${mutant.case}): ${mutant.description}; edits in ${mutant.ports.join(', ') || 'no port'}`);
  for (const row of result.parity) lines.push(`  go-parity ${row.id}: group ${row.group}${row.gaps.length ? `; gaps ${row.gaps.length}` : ''}${row.nativeGo.length ? `; native Go ${row.nativeGo.join(', ')}` : ''}`);
  return lines.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const wantJson = args.includes('--json');
  const query = args.find(arg => !arg.startsWith('--'));
  if (!query || args.length > 2) {
    console.error('Usage: node formal/tools/where.mjs <contract or case, e.g. C45 or C45.recheck-after-decode> [--json]');
    process.exitCode = 2;
  } else {
    try {
      const result = lookup(query);
      process.stdout.write(wantJson ? `${JSON.stringify(result, null, 2)}\n` : render(result));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
