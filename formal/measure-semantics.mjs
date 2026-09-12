import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { checkSemanticCoverage } from './check-semantic-coverage.mjs';
import { evaluateSemanticTestReport } from './semantic-reporter.mjs';
import { fingerprintFiles, gateDetections, languages, partitionMutations, shardDirectory, shardFromArguments } from './mutation-reports.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const language = languages.ts;
// --shard=<index>/<count> measures a contiguous slice of the catalog after the
// full baselines; the default is the complete single-process measurement.
const shard = shardFromArguments(process.argv.slice(2));
const reportRoot = resolve(root, language.output);
const output = shardDirectory(reportRoot, shard);
const read = path => readFileSync(resolve(root, path), 'utf8');
const started = Date.now();
// Invalidate any previous completed report even if preflight fails before an
// isolated workspace can be created (for example, a stale mutation anchor).
// A shard also invalidates the merged report above it, which is evidence only
// while every shard beneath it is current.
mkdirSync(reportRoot, { recursive: true });
writeFileSync(resolve(reportRoot, 'report.json'), JSON.stringify({ schemaVersion: 1, complete: false, startedAt: new Date(started).toISOString() }) + '\n');
rmSync(resolve(reportRoot, 'report.md'), { force: true });
if (output !== reportRoot) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, 'report.json'), JSON.stringify({ schemaVersion: 1, complete: false, shard: { index: shard.index, count: shard.count }, startedAt: new Date(started).toISOString() }) + '\n');
}
const declaredCoverage = checkSemanticCoverage();
const catalog = JSON.parse(read(language.catalog));
if (catalog.schemaVersion !== 1 || catalog.mutations.length === 0) throw new Error('Expected semantic mutation catalog');
const formalTests = ['test/formal-conformance.test.ts', 'test/formal-effects.test.ts', 'test/formal-features.test.ts', 'test/formal-local-clock.test.ts', 'test/formal-protocol-vectors.test.ts'];
const portableTests = ['test/formal-behavior.test.ts', 'test/formal-protocol-vectors.test.ts'];
const generatedPattern = 'replays |reaches every action|covers every action|reaches fractional expiry and shared instance grid|formal protocol conformance vectors (?!keeps |requires )';
// Fixed scenario names carry a feature prefix. Protocol schema/audit checks
// start with "keeps"/"requires" and must not count as behavioral detections.
const portablePattern = 'portable behavioral scenarios [\\w-]+: |formal protocol conformance vectors (?!keeps |requires )';
const cohorts = {
  ordinary: ['--exclude=test/formal*.test.ts'],
  generated: [...formalTests, `--testNamePattern=${generatedPattern}`],
  fixed: [...portableTests, `--testNamePattern=${portablePattern}`],
};
const comparisons = ['ordinary', 'generated', 'portable'];
// Generated and fixed cohorts select disjoint protocol rows. Their union
// measures the full portable suite without replaying any history or vector
// twice. Keep both component reports, including every failing assertion.
function portableResult({ generated, fixed }) {
  return { state: generated.failed + fixed.failed > 0 ? 'detected' : 'survived',
    passed: generated.passed + fixed.passed, failed: generated.failed + fixed.failed,
    failingTests: [...generated.failingTests, ...fixed.failingTests], components: ['generated', 'fixed'] };
}
const sourceText = new Map();
const ids = new Set();
// Every shard validates the whole catalog: a stale anchor anywhere fails each
// shard the same way it fails the single run.
for (const mutation of catalog.mutations) {
  if (!/^M\d+$/.test(mutation.id) || ids.has(mutation.id)) throw new Error('Invalid/duplicate mutation ID');
  ids.add(mutation.id);
  if (!/^src\/[\w/-]+\.ts$/.test(mutation.path) || mutation.before === mutation.after || !mutation.before) throw new Error(`Invalid edit: ${mutation.id}`);
  const original = read(mutation.path);
  if (original.split(mutation.before).length !== 2) throw new Error(`${mutation.id}: mutation anchor must match exactly once; review source drift`);
  if (!mutation.requiredDetections.every(c => comparisons.includes(c))) throw new Error(`Unknown cohort: ${mutation.id}`);
  sourceText.set(mutation.path, original);
}
const selected = partitionMutations(catalog.mutations, shard);
// A hard CI cancellation may bypass finally. Keep temporary dependency links
// outside the artifact tree even when that happens.
const workspace = mkdtempSync(resolve(tmpdir(), 'dialcache-semantic-'));
const report = {
  schemaVersion: 1,
  complete: false,
  ...(shard.count > 1 ? { shard: { index: shard.index, count: shard.count, mutationIds: selected.map(m => m.id) } } : {}),
  startedAt: new Date(started).toISOString(),
  revision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  node: process.version,
  catalogSha256: createHash('sha256').update(read(language.catalog)).digest('hex'),
  sourceSha256: Object.fromEntries([...sourceText].map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')])),
  declaredCoverage,
  baselines: {}, mutations: [],
};
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('DIALCACHE_')) delete env[key];
Object.assign(env, {
  DIALCACHE_MBT_TRACE_DIR: resolve(root, '.formal-traces/conformance'),
  DIALCACHE_EFFECTS_TRACE_DIR: resolve(root, '.formal-traces/effects'),
  DIALCACHE_FEATURE_TRACE_DIR: resolve(root, '.formal-traces/features'),
});
function run(label, cohort, baseline) {
  const json = resolve(output, `${label}-${cohort}.json`);
  const meta = resolve(output, `${label}-${cohort}.meta.json`);
  rmSync(json, { force: true });
  rmSync(meta, { force: true });
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', ...cohorts[cohort],
    // Vitest bail can cancel workers before their failing assertions reach the
    // JSON reporter. Complete each cohort so detection has recorded evidence.
    '--coverage.enabled=false', '--reporter=json', '--reporter=./formal/semantic-reporter.mjs', `--outputFile=${json}`], {
    cwd: workspace, env: { ...env, DIALCACHE_PROTOCOL_CORPUS: cohort === 'generated' ? 'generated' : 'fixed', DIALCACHE_SEMANTIC_RUN_META: meta },
    encoding: 'utf8', timeout: 540_000, maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(resolve(output, `${label}-${cohort}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error || result.signal) throw new Error(`${label}/${cohort}: runner failed: ${result.error ?? result.signal}`);
  let data, execution;
  try { data = JSON.parse(readFileSync(json, 'utf8')); execution = JSON.parse(readFileSync(meta, 'utf8')); } catch { throw new Error(`${label}/${cohort}: missing test report`); }
  const evaluated = evaluateSemanticTestReport(data, execution, result.status, `${label}/${cohort}`);
  const { state, passed } = evaluated;
  if (baseline && state !== 'survived') throw new Error(`${cohort}: unmodified baseline must pass`);
  if (!baseline && state === 'survived' && passed !== report.baselines[cohort].passed) throw new Error(`${label}/${cohort}: incomplete surviving run`);
  return evaluated;
}
function save() {
  report.elapsedSeconds = Math.round((Date.now() - started) / 1000);
  writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
save();
try {
  for (const path of ['src', 'test', 'formal', 'docs', 'README.md', 'go/README.md', 'package.json', 'tsconfig.json', 'vitest.config.ts']) {
    cpSync(resolve(root, path), resolve(workspace, path), { recursive: true, filter: source => !source.includes('/docs/.vitepress/cache') && !source.includes('/docs/.vitepress/dist') });
  }
  symlinkSync(resolve(root, 'node_modules'), resolve(workspace, 'node_modules'), 'dir');
  report.inputs = fingerprintFiles(root, language.inputs);
  report.configurationSha256 = Object.fromEntries(['package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vitest.config.ts'].map(path => [path, createHash('sha256').update(read(path)).digest('hex')]));
  report.corpus = fingerprintFiles(root, ['.formal-traces/conformance', '.formal-traces/effects', '.formal-traces/features', '.formal-traces/regressions']);
  rmSync(resolve(output, 'witnesses'), { recursive: true, force: true });
  // Every shard measures every baseline itself: its evidence stands on the
  // environment it ran in, and the merge refuses shards whose baselines differ.
  for (const cohort of Object.keys(cohorts)) {
    report.baselines[cohort] = run('baseline', cohort, true);
    console.log(`baseline ${cohort}: ${report.baselines[cohort].passed} passed`);
    save();
  }
  report.baselines.portable = portableResult(report.baselines);
  // The shared language-neutral evaluator produces the baseline witness
  // evidence over the unmodified corpus; the TypeScript suite only checks the gate.
  const evaluated = spawnSync(process.execPath, [resolve(root, 'formal/witnesses.mjs'), 'evaluate', '--profile', 'all', '--out', resolve(output, 'witnesses')],
    { cwd: root, env, encoding: 'utf8', timeout: 540_000 });
  if (evaluated.error || evaluated.status !== 0) throw new Error(`baseline witness evaluation failed: ${evaluated.error ?? evaluated.stderr}`);
  const witnesses = JSON.parse(read('formal/coverage-witnesses.json'));
  report.reachedWitnesses = {};
  for (const [profile, required] of Object.entries(witnesses)) {
    const evidence = JSON.parse(readFileSync(resolve(output, `witnesses/${profile}.json`), 'utf8'));
    if (evidence.profile !== profile || evidence.traces <= 0 || required.some(w => !evidence.seen.includes(w))) throw new Error(`${profile}: incomplete baseline witness evidence`);
    report.reachedWitnesses[profile] = { required: required.length, reached: required.filter(w => evidence.seen.includes(w)).length, traces: evidence.traces };
  }
  for (const mutation of selected) {
    const path = resolve(workspace, mutation.path), original = sourceText.get(mutation.path);
    try {
      writeFileSync(path, original.replace(mutation.before, mutation.after));
      const compile = spawnSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: workspace, encoding: 'utf8', timeout: 60_000 });
      if (compile.status !== 0 || compile.error) throw new Error(`${mutation.id}: invalid/noncompiling mutant\n${compile.stdout ?? ''}${compile.stderr ?? ''}`);
      const result = { id: mutation.id, case: mutation.case, description: mutation.description, cohorts: {} };
      for (const cohort of Object.keys(cohorts)) result.cohorts[cohort] = run(mutation.id, cohort, false);
      result.cohorts.portable = portableResult(result.cohorts);
      report.mutations.push(result);
      console.log(`${mutation.id}: ${Object.entries(result.cohorts).map(([name, run]) => `${name}=${run.state}`).join(', ')}`);
      save();
    } finally { writeFileSync(path, original); }
  }
  if (shard.count > 1) {
    // A shard gates its own slice and stays incomplete; the merge recomputes the
    // gate and the detection summary over the whole catalog.
    gateDetections(language, report, selected, { directory: root, summarize: false });
    save();
    console.log(`Shard ${shard.index}/${shard.count} measured ${selected.length} mutations: ${relative(root, output)}/report.json; merge with node formal/merge-mutation-reports.mjs ts`);
  } else {
    gateDetections(language, report, catalog.mutations, { directory: root });
    save();
    writeFileSync(resolve(output, 'report.md'), language.markdown(report));
    console.log(`Report: ${relative(root, output)}/report.md`);
  }
} catch (error) {
  report.complete = false;
  report.error = String(error);
  save();
  throw error;
} finally {
  // Only this run's isolated copy is removed. The user's source is never edited.
  rmSync(workspace, { recursive: true, force: true });
}
