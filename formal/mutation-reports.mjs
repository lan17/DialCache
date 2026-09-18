import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { challengesByMutant, mutantCatalogPath, mutantIdPattern, mutantPorts } from './execution.mjs';

// Shared by measure-semantics.mjs, measure-go-semantics.mjs and
// merge-mutation-reports.mjs: the catalog selection, the input fingerprint,
// the detection summary and the required-detection gate. One implementation
// keeps a merged report exactly as strict as a single-process one.
const root = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// --shard=<index>/<count> is 1-based; the default 1/1 is the complete
// single-process measurement.
export function parseShard(value) {
  if (value === undefined) return { index: 1, count: 1 };
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`Expected <index>/<count> with 1 <= index <= count; got ${JSON.stringify(value)}`);
  return { index: Number(match[1]), count: Number(match[2]) };
}

// --only=<id>,<id> names distinct catalog mutants for a partial measurement.
export function parseOnly(value) {
  if (value === undefined) return undefined;
  const ids = value.split(',');
  if (ids.some(id => !mutantIdPattern.test(id)) || new Set(ids).size !== ids.length) throw new Error(`Expected <id>,<id> naming distinct mutant ids; got ${JSON.stringify(value)}`);
  return ids;
}

// A measurement selects the whole catalog, one shard of it, or the named
// mutants. A shard is evidence once every shard is merged; a partial run of
// named mutants is a local iteration aid and never complete evidence, so the
// two exclude each other.
export function selectionFromArguments(argv) {
  let shard, only;
  for (const argument of argv) {
    if (argument.startsWith('--shard=') && shard === undefined) shard = argument.slice('--shard='.length);
    else if (argument.startsWith('--only=') && only === undefined) only = argument.slice('--only='.length);
    else throw new Error(`Usage: --shard=<index>/<count> or --only=<id>,<id>; unexpected argument ${argument}`);
  }
  if (shard !== undefined && only !== undefined) throw new Error('--shard and --only exclude each other: a partial run is never merged');
  return { shard: parseShard(shard), only: parseOnly(only) };
}

// A contiguous slice of the catalog in catalog order; the first
// (mutations mod count) shards take one mutation more. A shard beyond the
// catalog is empty and still measures its baselines.
export function partitionMutations(mutations, { index, count }) {
  const base = Math.floor(mutations.length / count), extra = mutations.length % count;
  const start = (index - 1) * base + Math.min(index - 1, extra);
  return mutations.slice(start, start + base + (index <= extra ? 1 : 0));
}

// The catalog entries one measurement runs, in catalog order.
export function selectMutations(mutations, { shard, only }) {
  if (only === undefined) return partitionMutations(mutations, shard);
  const unknown = only.filter(id => !mutations.some(mutation => mutation.id === id));
  if (unknown.length) throw new Error(`Unknown mutation ids: ${unknown.join(', ')}`);
  return mutations.filter(mutation => only.includes(mutation.id));
}

// Shards from separate jobs land in one tree without colliding, a partial run
// lands beside them without touching the complete report, and the single run
// keeps today's location.
export function selectionDirectory(output, { shard, only }) {
  if (only !== undefined) return resolve(output, 'partial');
  return shard.count === 1 ? output : resolve(output, 'shards', `${shard.index}-of-${shard.count}`);
}

// Hash the reviewed inputs, including uncommitted edits and exact file bytes.
// Git revision alone cannot identify an exploratory run from a dirty worktree.
export function fingerprintFiles(directory, paths) {
  const files = [];
  const visit = path => {
    for (const entry of readdirSync(resolve(directory, path), { withFileTypes: true })) {
      if (entry.isDirectory()) visit(`${path}/${entry.name}`);
      else if (entry.isFile()) files.push(`${path}/${entry.name}`);
    }
  };
  for (const path of paths) visit(path);
  files.sort();
  const digest = createHash('sha256');
  for (const path of files) digest.update(path).update('\0').update(readFileSync(resolve(directory, path))).update('\0');
  return { files: files.length, sha256: digest.digest('hex') };
}

// Every listed catalog entry must have a measured result; a required cohort
// that did not detect the fault is a regression named `<id>/<cohort>`.
export function requiredDetectionRegressions(entries, results) {
  return entries.flatMap(entry => {
    const result = results.find(item => item.id === entry.id);
    if (!result) throw new Error(`${entry.id}: catalog entry has no measured result`);
    return entry.requiredDetections.filter(cohort => result.cohorts[cohort].state !== 'detected').map(cohort => `${entry.id}/${cohort}`);
  });
}

// A cohort the measurement could not run (a noncompiling mutant, or the port's
// own suite crashing under it) is outside the measured total and listed apart
// from survivors; it is never a detection.
const unmeasured = (mutations, cohort) => mutations.filter(m => m.cohorts[cohort].state === 'crashed').map(m => m.id);
export function typescriptDetection(mutations, cases) {
  const comparisons = mutantPorts.typescript.cohorts;
  const score = selected => Object.fromEntries(comparisons.map(cohort => {
    const measured = selected.filter(m => m.cohorts[cohort].state !== 'crashed');
    const detected = measured.filter(m => m.cohorts[cohort].state === 'detected');
    const ordinary = measured.filter(m => m.cohorts.ordinary.state === 'detected');
    const crashed = unmeasured(selected, cohort);
    return [cohort, { detected: detected.length, total: measured.length,
      ordinaryParity: { detected: ordinary.filter(m => m.cohorts[cohort].state === 'detected').length, total: ordinary.length },
      survivors: measured.filter(m => m.cohorts[cohort].state === 'survived').map(m => m.id), ...(crashed.length ? { crashed } : {}) }];
  }));
  const protocol = m => cases.find(c => c.id === m.case).vectors.length > 0;
  return { all: score(mutations), behavioral: score(mutations.filter(m => !protocol(m))), protocol: score(mutations.filter(protocol)) };
}

export function goDetection(mutations) {
  return Object.fromEntries(mutantPorts.go.cohorts.map(cohort => {
    const measured = mutations.filter(m => m.cohorts[cohort].state !== 'crashed');
    const crashed = unmeasured(mutations, cohort);
    return [cohort, {
      detected: measured.filter(m => m.cohorts[cohort].state === 'detected').length, total: measured.length,
      survivors: measured.filter(m => m.cohorts[cohort].state === 'survived').map(m => m.id),
      ...(crashed.length ? { crashed } : {}),
    }];
  }));
}

// The record of a cohort the measurement could not run for a mutant.
export const crashedCohort = reason => ({ state: 'crashed', reason, passed: 0, failed: 0, failingTests: [] });

// One rule for both ports: the port's own unit suite is informational for a
// mutant, so when its evaluation throws (a synctest bubble panicking on a
// goroutine the fault leaves blocked, an unhandled rejection with no failed
// assertion) the cohort is recorded as crashed and the run continues. The
// baseline and the replay cohorts keep the strict rule: their throw fails the
// measurement.
export function classifyCohort({ baseline, cohort }, evaluate) {
  try { return evaluate(); } catch (error) {
    if (baseline || cohort !== 'ordinary') throw error;
    return crashedCohort(error.message);
  }
}

// A mutant that does not compile is recorded with every cohort crashed, so
// the gate names the mutant and the rest of the shard is still measured.
export function noncompilingResult(mutation, cohorts, reason) {
  return { id: mutation.id, case: mutation.case, description: mutation.description, cohorts: Object.fromEntries(cohorts.map(cohort => [cohort, crashedCohort(reason)])) };
}

// A partial (--only) run reports its lost required detections and stops: it
// is not gated and never completes, so the complete report is untouched.
export function finishPartial(report, selected, { output, save }) {
  const lost = requiredDetectionRegressions(selected, report.mutations);
  save();
  console.log(lost.length ? `Lost required detections (a partial run is not gated): ${lost.join(', ')}` : 'Every required detection of the selected mutants held');
  console.log(`Partial measurement of ${selected.map(m => m.id).join(', ')}: ${output}/report.json; measure the complete catalog for evidence`);
  // An authoring loop should notice a lost detection without reading the log.
  if (lost.length) process.exitCode = 1;
  return report;
}

// The model challenges each mutant is the native twin of, from the execution
// manifest of the checkout the report describes.
function challengesColumn(directory) {
  const index = challengesByMutant(JSON.parse(readFileSync(resolve(directory, 'formal/execution.json'), 'utf8')));
  return id => (index.get(id) ?? []).join(', ') || 'none';
}

function typescriptMarkdown(report, directory = root) {
  const challenges = challengesColumn(directory);
  return ['# Semantic coverage measurement', '',
    `Completed in ${report.elapsedSeconds}s. Inventory and mutation counts describe named cases, not universal semantic completeness.`, '',
    ...shardsMarkdown(report),
    '| Scope | Cases | Portable execution references | Required generated witnesses |',
    '| --- | ---: | ---: | ---: |',
    ...['cases', 'behavioral', 'protocol'].map(scope => { const c = report.declaredCoverage[scope]; return `| ${scope} | ${c.total} | ${c.portable} | ${c.generated} |`; }), '',
    'Protocol references include invalidation vectors exercised separately by integration CI. Model references are a conservative named-property subset, not total model coverage.', '',
    '| Mutation | Case | Challenges | Ordinary | Generated | Full portable |', '| --- | --- | --- | --- | --- | --- |',
    ...report.mutations.map(m => `| ${m.id} | ${m.case} | ${challenges(m.id)} | ${m.cohorts.ordinary.state} | ${m.cohorts.generated.state} | ${m.cohorts.portable.state} |`), '',
    'Challenges are the model property challenges whose fault the mutant injects natively (nativeMutants in formal/execution.json). Full JSON includes exact input/corpus hashes, cohort counts, reached witnesses, behavioral/protocol scores, and failing test names. Adjacent JSON/log files retain assertion diagnostics and trace paths.', ''].join('\n');
}

function goMarkdown(report, directory = root) {
  const challenges = challengesColumn(directory);
  return ['# Go semantic mutation measurement', '', `Completed in ${report.elapsedSeconds}s. Counts measure this named fault catalog and exact corpus, not universal equivalence.`, '',
    ...shardsMarkdown(report),
    '| Mutation | Contract case | Challenges | Ordinary | Quint generated | Fixed supplement | Full portable |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.mutations.map(m => `| ${m.id} | ${m.case} | ${challenges(m.id)} | ${m.cohorts.ordinary.state} | ${m.cohorts.generated.state} | ${m.cohorts.fixed.state} | ${m.cohorts.portable.state} |`), '',
    'Challenges are the model property challenges whose fault the mutant injects natively (nativeMutants in formal/execution.json). Full JSON records snapshot/corpus/witness fingerprints, selected tests, actual passing/failing leaf counts, and assertion diagnostics. Compilation errors, crashes, timeouts, missing witnesses, and skipped executions cannot count as detections.', ''].join('\n');
}

// Only a merged report carries `shards`; the single run's markdown is unchanged.
function shardsMarkdown(report) {
  if (!report.shards) return [];
  return [`Merged from ${report.shards.length} shards that each reran the baselines: ${report.shards.map(s => `${s.index} (${s.mutationIds.join(', ') || 'no mutations'}, ${s.elapsedSeconds}s)`).join('; ')}.`, ''];
}

// Per-language knowledge: where the report lives, which catalog and inputs it
// measures, how its detection summary is scored and rendered, and whether the
// report records the regression list (the Go report does; the TypeScript
// report only fails on it).
export const languages = {
  ts: { name: 'TypeScript', port: 'typescript', output: '.formal-traces/semantic', catalog: mutantCatalogPath, inputs: ['src', 'test', 'formal'],
    detection: (mutations, directory) => typescriptDetection(mutations, JSON.parse(readFileSync(resolve(directory, 'formal/semantic-cases.json'), 'utf8')).cases),
    markdown: typescriptMarkdown, recordsRegressions: false },
  go: { name: 'Go', port: 'go', output: '.formal-traces/go-semantic', catalog: mutantCatalogPath, inputs: ['formal', 'go', 'test', 'src'],
    detection: mutations => goDetection(mutations), markdown: goMarkdown, recordsRegressions: true },
};

// The same gate for a shard (its own catalog entries, no summary), the
// single-process run and the merge (the whole catalog, summary, completion).
// A shard therefore fails on its own lost detections before any merge, and the
// merged summary is computed by the code the single run uses.
export function gateDetections(language, report, entries, { directory = root, summarize = true } = {}) {
  const regressions = requiredDetectionRegressions(entries, report.mutations);
  if (summarize) report.detection = language.detection(report.mutations, directory);
  if (language.recordsRegressions) report.requiredDetectionRegressions = regressions;
  if (regressions.length) throw new Error(`Lost required detections: ${regressions.join(', ')}`);
  if (summarize) report.complete = true;
}
