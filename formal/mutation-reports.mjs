import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundaryEvidence, challengesByMutant, mutantCatalogPath, mutantIdPattern, mutantPorts } from './execution.mjs';
import { countingPaths } from './replay/divergence.mjs';
import { assessVectorBoundary } from './vector-evidence.mjs';

// Preserve profile/run identity when workspaces and artifact roots differ.
export function historyFromPath(path) {
  return /(?:^|\/)regressions\/([a-z-]+\/[^/]+)\.itf\.json$/.exec(String(path))?.[1];
}

// Boundary recordings are separate from the ordinary detection cohorts. A
// failed driver or incomplete history never earns credit, even if it diverged
// earlier. Counters already wrong at the previous step cannot impersonate a
// consequence at this checkpoint.
export function assessBoundary(evidence, recording) {
  if (evidence.vector) return assessVectorBoundary(evidence, recording);
  const result = { ...evidence, via: 'coordinator' };
  if (['vector', 'unreproduced'].includes(evidence.state)) return result;
  result.completed = recording?.completed === true;
  result.lastStep = recording?.lastStep ?? -1;
  const unreached = reason => ({ ...result, state: 'unreached', reason,
    divergences: Array.isArray(recording?.divergences) ? recording.divergences : [] });
  if (!recording) return unreached('No boundary recording was produced');
  if (historyFromPath(recording.path) !== evidence.history) return unreached(`Recording names a different history: ${recording.path}`);
  if (recording.completed !== true || recording.error !== undefined) return unreached(recording.error ?? `History stopped after observation ${recording.lastStep}`);
  if (!Number.isSafeInteger(recording.lastStep) || recording.lastStep < evidence.step) return unreached(`Checkpoint ${evidence.step} was not reached (last observation ${recording.lastStep})`);
  const divergences = recording.divergences;
  if (!Array.isArray(divergences) || divergences.some((item, index) => !Number.isSafeInteger(item.step) || item.step < 0 || item.step > recording.lastStep ||
      (index > 0 && item.step <= divergences[index - 1].step) || !Array.isArray(item.paths) || !item.paths.length || item.paths.some(path => typeof path !== 'string'))) {
    return unreached('Malformed divergence recording');
  }
  const at = divergences.find(item => item.step === evidence.step)?.paths ?? [];
  const before = divergences.find(item => item.step === evidence.step - 1)?.paths ?? [];
  const matched = countingPaths(evidence.fields, at, before);
  return { ...result, state: matched.length ? 'confirmed' : divergences.length ? 'side-effect-only' : 'not-divergent',
    divergences, ...(matched.length ? { matched } : {}) };
}

export function boundaryColumn(entries) {
  if (!entries) return 'not recorded';
  const measured = entries.filter(entry => !['vector', 'unreproduced'].includes(entry.state));
  const counts = `confirmed ${measured.filter(entry => entry.state === 'confirmed').length}/${measured.length}`;
  const gaps = ['vector', 'unreproduced'].map(state => `${state} ${entries.filter(entry => entry.state === state).length}`);
  const failures = measured.filter(entry => entry.state !== 'confirmed').map(entry => `${entry.challenge}: ${entry.state}`);
  return [counts, ...gaps, ...failures].join('; ');
}

// Shared by measure-semantics.mjs, measure-go-semantics.mjs and
// merge-mutation-reports.mjs: the catalog selection, the input fingerprint,
// the detection summary and the required-detection gate. One implementation
// keeps a merged report exactly as strict as a single-process one.
const root = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// --shard=<index>/<count> is 1-based; the default 1/1 is the complete
// single-process measurement. The differential (formal/differential.mjs) and
// the runner's DIFFERENTIAL_SHARD read the same form with this parser.
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
// `exclude` names build output beneath an input (the Rust target directory)
// that is neither reviewed nor stable.
export function fingerprintFiles(directory, paths, { exclude = [] } = {}) {
  const files = [];
  const skipped = new Set(exclude);
  const visit = path => {
    if (skipped.has(path)) return;
    if (statSync(resolve(directory, path)).isFile()) { files.push(path); return; }
    for (const entry of readdirSync(resolve(directory, path), { withFileTypes: true })) {
      if (entry.isDirectory()) visit(`${path}/${entry.name}`);
      else if (entry.isFile() && !skipped.has(`${path}/${entry.name}`)) files.push(`${path}/${entry.name}`);
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
export function requiredDetectionRegressions(entries, results, boundaries = results.flatMap(result => result.boundary ?? [])) {
  return entries.flatMap(entry => {
    const result = results.find(item => item.id === entry.id);
    if (!result) throw new Error(`${entry.id}: catalog entry has no measured result`);
    return [
      ...entry.requiredDetections.filter(cohort => result.cohorts[cohort].state !== 'detected').map(cohort => `${entry.id}/${cohort}`),
      ...boundaries.filter(boundary => boundary.mutant === entry.id && !['confirmed', 'vector', 'unreproduced'].includes(boundary.state))
        .map(boundary => `${entry.id}/boundary:${boundary.challenge}`),
    ];
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

// The four-cohort score shared by the Go and Rust measurements.
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

// Portable evidence is the generated and fixed replay cohorts together. A
// component the measurement could not run leaves portable unmeasured as well,
// as a noncompiling mutant does: the other component alone is not portable
// evidence, and a crashed cohort is never a detection.
export function portableCohort(generated, fixed) {
  for (const [name, component] of Object.entries({ generated, fixed })) {
    if (component.state === 'crashed') return crashedCohort(`${name}: ${component.reason}`);
  }
  return { state: generated.failed + fixed.failed > 0 ? 'detected' : 'survived',
    passed: generated.passed + fixed.passed, failed: generated.failed + fixed.failed,
    failingTests: [...generated.failingTests, ...fixed.failingTests], components: ['generated', 'fixed'] };
}

// One rule for both ports: the port's own unit suite is informational for a
// mutant, so when its evaluation throws (a synctest bubble panicking on a
// goroutine the fault leaves blocked, an unhandled rejection with no failed
// assertion) the cohort is recorded as crashed and the run continues. A
// settlement violation under a mutant is the driver failing its own contract,
// never comparison evidence; it is recorded as a crashed cohort naming the
// first violating history and rule, so the gate fails by mutant id while the
// rest of the shard is measured. The baseline and every other replay-cohort
// failure keep the strict rule: their throw fails the measurement.
export function classifyCohort({ baseline, cohort }, evaluate) {
  try { return evaluate(); } catch (error) {
    if (baseline) {
      // A baseline that violates settlement fails the measurement; name the rule so the log alone says why.
      if (error.settlementViolation !== undefined) error.message += ` (settlement violation: ${error.settlementViolation})`;
      throw error;
    }
    if (error.settlementViolation !== undefined) return crashedCohort(`settlement violation: ${error.settlementViolation}`);
    if (cohort !== 'ordinary') throw error;
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
  const lost = requiredDetectionRegressions(selected, report.mutations, currentBoundaries(report, selected));
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
    '| Mutation | Case | Challenges | Ordinary | Generated | Full portable | Boundary |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.mutations.map(m => `| ${m.id} | ${m.case} | ${challenges(m.id)} | ${m.cohorts.ordinary.state} | ${m.cohorts.generated.state} | ${m.cohorts.portable.state} | ${boundaryColumn(m.boundary)} |`), '',
    'Challenges are the model property challenges whose fault the mutant injects natively (nativeMutants in formal/execution.json). Full JSON includes exact input/corpus hashes, cohort counts, reached witnesses, behavioral/protocol scores, and failing test names. Adjacent JSON/log files retain assertion diagnostics and trace paths.', ''].join('\n');
}

function goMarkdown(report, directory = root) {
  const challenges = challengesColumn(directory);
  return ['# Go semantic mutation measurement', '', `Completed in ${report.elapsedSeconds}s. Counts measure this named fault catalog and exact corpus, not universal equivalence.`, '',
    ...shardsMarkdown(report),
    '| Mutation | Contract case | Challenges | Ordinary | Quint generated | Fixed supplement | Full portable | Boundary |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.mutations.map(m => `| ${m.id} | ${m.case} | ${challenges(m.id)} | ${m.cohorts.ordinary.state} | ${m.cohorts.generated.state} | ${m.cohorts.fixed.state} | ${m.cohorts.portable.state} | ${boundaryColumn(m.boundary)} |`), '',
    'Challenges are the model property challenges whose fault the mutant injects natively (nativeMutants in formal/execution.json). Full JSON records snapshot/corpus/witness fingerprints, selected tests, actual passing/failing leaf counts, and assertion diagnostics. Compilation errors, crashes, timeouts, missing witnesses, and skipped executions cannot count as detections.', ''].join('\n');
}

function rustMarkdown(report) {
  return ['# Rust semantic mutation measurement', '', `Completed in ${report.elapsedSeconds}s. Counts measure this named fault catalog and exact corpus, not universal equivalence.`, '',
    ...shardsMarkdown(report),
    'Scope: Rust native mutation catalog only. Shared TypeScript/Go model-challenge boundary coverage is not measured by this report.', '',
    ...(report.scope ? [`Shared catalog mutants without a Rust binding: ${report.scope.unmappedSharedMutations.join(', ') || 'none'}.`, ''] : []),
    '| Mutation | Contract case | Ordinary | Quint generated | Fixed supplement | Full portable |', '| --- | --- | --- | --- | --- | --- |',
    ...report.mutations.map(m => `| ${m.id} | ${m.case} | ${m.cohorts.ordinary.state} | ${m.cohorts.generated.state} | ${m.cohorts.fixed.state} | ${m.cohorts.portable.state} |`), '',
    'Ordinary is the crate\'s unit and native tests; generated is the conformance harness over the complete corpus and witness evidence; fixed is the harness over the fixed scenarios and checked-in vectors. Full JSON records snapshot/corpus/witness fingerprints, cohort selections, actual passing/failing counts and assertion diagnostics. Compilation errors, crashes, timeouts, missing reports and incomplete runs cannot count as detections.', ''].join('\n');
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
  // The crate's unit tests read go/redis_adapter.go (script byte equality), so
  // the Go source is an input of the ordinary cohort as well.
  rust: { name: 'Rust', boundaryEvidence: false, output: '.formal-traces/rust-semantic', catalog: 'formal/rust-mutations.json', inputs: ['formal', 'rust', 'test', 'src', 'go'], exclude: ['rust/target'],
    detection: mutations => goDetection(mutations), markdown: rustMarkdown, recordsRegressions: true },
};

// Historical inspection may read a report anywhere. Gated inspection instead
// binds its evidence to this checkout and the exact corpus it claims to test.
// Existing report formats distinguish Go by its toolchain version and
// TypeScript by its separately fingerprinted project configuration; Go's
// module configuration is already covered by the go/ input tree.
export function validateBoundaryReportFreshness(report, { directory = root } = {}) {
  const go = typeof report.go === 'string';
  const typescript = report.configurationSha256 !== undefined;
  if (go === typescript) throw new Error('Boundary gate requires unambiguous TypeScript or Go report metadata');
  const language = go ? languages.go : languages.ts;
  const catalogSha256 = sha256(readFileSync(resolve(directory, language.catalog)));
  if (report.catalogSha256 !== catalogSha256) throw new Error('Boundary gate: mutation catalog differs from the measured report');
  const sameFingerprint = (recorded, measured) => recorded?.files === measured.files && recorded?.sha256 === measured.sha256;
  if (!sameFingerprint(report.inputs, fingerprintFiles(directory, language.inputs))) {
    throw new Error(`Boundary gate: ${language.name} source inputs differ from the measured report`);
  }
  if (typescript) {
    const configuration = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vitest.config.ts'];
    const recorded = report.configurationSha256;
    if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded) ||
        Object.keys(recorded).sort().join() !== [...configuration].sort().join() ||
        configuration.some(path => recorded[path] !== sha256(readFileSync(resolve(directory, path))))) {
      throw new Error('Boundary gate: TypeScript configuration differs from the measured report');
    }
  }
  const corpus = fingerprintFiles(directory, ['.formal-traces/conformance', '.formal-traces/effects', '.formal-traces/features', '.formal-traces/regressions']);
  if (!sameFingerprint(report.corpus, corpus)) throw new Error('Boundary gate: corpus differs from the measured report');
}

// The same gate for a shard (its own catalog entries, no summary), the
// single-process run and the merge (the whole catalog, summary, completion).
// A shard therefore fails on its own lost detections before any merge, and the
// merged summary is computed by the code the single run uses.
export function gateDetections(language, report, entries, { directory = root, summarize = true } = {}) {
  // Recompute verdicts from the current declarations and completed recordings.
  // An omitted mapping, a stale pin or a claimed confirmation without a clean
  // baseline must fail just as a measured non-detection does.
  const boundaries = language.boundaryEvidence === false ? [] : currentBoundaries(report, entries, directory);
  const regressions = requiredDetectionRegressions(entries, report.mutations, boundaries);
  if (summarize) report.detection = language.detection(report.mutations, directory);
  if (language.recordsRegressions) report.requiredDetectionRegressions = regressions;
  if (regressions.length) throw new Error(`Lost required detections: ${regressions.join(', ')}`);
  if (summarize) report.complete = true;
}

function currentBoundaries(report, entries, directory = root) {
  const readSource = path => readFileSync(resolve(directory, path), 'utf8');
  const ids = new Set(entries.map(entry => entry.id));
  const evidence = boundaryEvidence(JSON.parse(readSource('formal/execution.json')), { readSource })
    .filter(entry => ids.has(entry.mutant));
  return boundaryReview(report, evidence, { requireEntries: true });
}

// Boundary evidence comes only from explicit recordings. Raw assertion logs
// remain diagnostic artifacts and cannot establish a completed history.
export function boundaryReview(report, evidence, { requireEntries = false } = {}) {
  if (!Array.isArray(report.mutations)) throw new Error('Boundary report has no mutation results');
  const goReport = typeof report.go === 'string', typescriptReport = report.configurationSha256 !== undefined;
  const reportPort = goReport === typescriptReport ? undefined : goReport ? 'go' : 'typescript';
  if (new Set(report.mutations.map(mutation => mutation.id)).size !== report.mutations.length) throw new Error('Boundary report repeats a mutant');
  for (const mutation of report.mutations) {
    if (mutation.boundary && new Set(mutation.boundary.map(entry => entry.challenge)).size !== mutation.boundary.length) {
      throw new Error(`Boundary report repeats a challenge for ${mutation.id}`);
    }
  }
  return evidence.map(entry => {
    const mutation = report.mutations.find(mutation => mutation.id === entry.mutant);
    if (!mutation) return { ...entry, state: 'unreached', reason: 'Mapped mutant is absent from the report', divergences: [] };
    const recorded = mutation.boundary?.find(item => item.challenge === entry.challenge);
    if (!recorded && requireEntries) return { ...entry, state: 'unreached', reason: 'No per-challenge boundary result was recorded', divergences: [] };
    if (recorded) {
      const same = ['mutant', 'history', 'step', 'fields', 'origin', 'vector'].every(key => JSON.stringify(recorded[key]) === JSON.stringify(entry[key]));
      if (!same || (entry.state && recorded.state !== entry.state)) return { ...entry, state: 'unreached', reason: 'Recorded boundary differs from the current evidence declaration', divergences: recorded.divergences ?? [] };
      if (entry.state) return { ...entry, via: 'coordinator' };
      const baseline = report.boundaryBaselines?.[entry.history];
      if (entry.vector) {
        if (!reportPort || recorded.vectorResult?.port !== reportPort || baseline?.vectorResult?.port !== reportPort)
          return { ...entry, state: 'unreached', reason: 'Vector records do not match the report language', divergences: [] };
        if (assessVectorBoundary(entry, baseline).state !== 'not-divergent') return { ...entry, state: 'unreached',
          reason: 'No clean completed baseline for this vector', divergences: [] };
        if (recorded.vectorResult?.port !== baseline.vectorResult.port) return { ...entry, state: 'unreached',
          reason: 'Vector baseline and mutation use different bindings', divergences: [] };
        return assessVectorBoundary(entry, { completed: recorded.completed, lastStep: recorded.lastStep, vectorResult: recorded.vectorResult,
          ...(recorded.reason ? { error: recorded.reason } : {}) });
      }
      if (baseline?.history !== entry.history || baseline.completed !== true || baseline.error !== undefined ||
          !Array.isArray(baseline.divergences) || baseline.divergences.length || !Number.isSafeInteger(baseline.lastStep) || baseline.lastStep < entry.step) {
        return { ...entry, state: 'unreached', reason: 'No clean completed baseline for this boundary', divergences: recorded.divergences ?? [] };
      }
      return assessBoundary(entry, { path: `regressions/${entry.history}.itf.json`, completed: recorded.completed, lastStep: recorded.lastStep,
        divergences: recorded.divergences, ...(recorded.reason ? { error: recorded.reason } : {}) });
    }
    if (entry.state) return { ...entry, via: 'legacy' };
    return { ...entry, via: 'legacy', state: 'unreached', reason: 'No complete boundary recording', divergences: [] };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      const name = args[i];
      if (name === '--gate') options.gate = true;
      else if (name === '--report' && args[i + 1] && !args[i + 1].startsWith('--')) options.report = args[++i];
      else throw new Error(`Unknown or incomplete option: ${name}`);
    }
    if (command !== 'boundary' || !options.report) throw new Error('Usage: node formal/mutation-reports.mjs boundary --report <report.json> [--gate]');
    const { boundaryEvidence } = await import('./execution.mjs');
    const report = JSON.parse(readFileSync(options.report, 'utf8'));
    if (options.gate) validateBoundaryReportFreshness(report);
    const entries = boundaryReview(report, boundaryEvidence(), { requireEntries: options.gate === true });
    console.log(JSON.stringify({ sourceReport: resolve(options.report), entries }, null, 2));
    if (options.gate && (report.complete !== true || entries.some(entry => !['confirmed', 'vector', 'unreproduced'].includes(entry.state)))) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
