import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { causalPropertyAssertion } from './measure-go-semantics.mjs';
import { mutantCatalogPath, mutantsForPort, readMutantCatalog } from './execution.mjs';
import { fingerprintFiles, gateDetections, languages, selectMutations, selectionDirectory, selectionFromArguments } from './mutation-reports.mjs';

// The Rust counterpart of measure-go-semantics.mjs: apply each catalogued
// fault to an isolated copy of the crate, require it to compile, and run three
// cohorts against it. Detection is an assertion failure; a compiler error,
// crash, timeout, missing report or incomplete run fails the measurement.
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));

// Test binaries that are the harness itself, its negative control, harness
// infrastructure, the protocol vector suites (the harness replays those
// vectors in the generated and fixed cohorts) or real servers are not
// ordinary tests.
export const infrastructureTestFile = /^(?:conformance|settlement_control|harness_infra|redis_integration|protocol_\w+)\.rs$/;

// libtest prints one `test <name> ... <outcome>` line per test and one
// `test result:` line per binary; `cargo test --no-fail-fast` runs every
// selected binary even after one fails. Names are qualified by their binary
// because unit and integration tests may share module paths.
export function evaluateCargoTestOutput(output, exitCode, expectedBinaries) {
  const tests = new Map();
  let binary = '', results = 0, passed = 0, failed = 0;
  for (const line of output.split('\n')) {
    const running = /^\s*Running (?:unittests )?(\S+)/.exec(line);
    if (running) { binary = running[1]; continue; }
    const test = /^test (\S+) \.\.\. (ok|FAILED|ignored)/.exec(line);
    if (test) {
      const name = `${binary}::${test[1]}`;
      if (tests.has(name)) throw new Error(`duplicate test execution ${name}`);
      tests.set(name, test[2]);
      continue;
    }
    const result = /^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(line);
    if (result) { results += 1; passed += Number(result[2]); failed += Number(result[3]); }
  }
  if (!results) throw new Error('no libtest result line: the ordinary cohort did not run');
  if (expectedBinaries !== undefined && results !== expectedBinaries) throw new Error(`expected ${expectedBinaries} test binaries to report, saw ${results}`);
  const failingTests = [...tests].filter(([, outcome]) => outcome === 'FAILED').map(([name]) => name);
  if (failed !== failingTests.length) throw new Error('libtest totals disagree with the listed outcomes');
  if (exitCode !== 0 && !failed) throw new Error(`cargo test exited ${exitCode} without a failing test: infrastructure failure`);
  if (exitCode === 0 && failed) throw new Error('cargo test exited 0 with failing tests');
  return { state: failed ? 'detected' : 'survived', passed, failed, failingTests,
    executedTests: [...tests].filter(([, outcome]) => outcome !== 'ignored').map(([name]) => name) };
}

// The harness writes one JSON object per line: a start header, one case per
// inventory id and a finish footer. A missing footer means the run crashed or
// timed out and is not evidence either way.
export function evaluateRustReport(text, exitCode, stderr = '') {
  if (/^conformance harness failed:|^coverage:/m.test(stderr)) throw new Error('Rust harness infrastructure or coverage failure');
  const records = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (!records.length) throw new Error('empty Rust harness report');
  const [start] = records;
  if (start.kind !== 'start' || start.schemaVersion !== 1 || start.implementation !== 'rust') throw new Error('Rust harness report lacks its start header');
  const finish = records.at(-1);
  if (finish.kind !== 'finish') throw new Error('Rust harness report has no finish record: the run crashed or timed out');
  const cases = records.slice(1, -1);
  const seen = new Set();
  const assertionKinds = {}, assertionEvidence = {};
  for (const record of cases) {
    if (record.kind !== 'case' || typeof record.id !== 'string' || !['passed', 'failed'].includes(record.status)) throw new Error('malformed Rust harness case record');
    if (seen.has(record.id)) throw new Error(`duplicate case ${record.id}`);
    seen.add(record.id);
    const category = record.id.split('/')[0];
    if (!['sampled', 'regression', 'scenario', 'protocol', 'witness'].includes(category)) throw new Error(`unknown Rust case ${record.id}`);
    if (record.status === 'failed') {
      if (category === 'witness') throw new Error(`witness audit failure ${record.id}`);
      const message = record.message;
      if (typeof message !== 'string' || !message) throw new Error(`failure has no assertion evidence: ${record.id}`);
      if (category === 'protocol') {
        if (!/PROTOCOL_ASSERTION_FAILURE expected:[\s\S]*actual:/.test(message)) throw new Error(`protocol failure lacks assertion evidence: ${record.id}`);
        assertionKinds[record.id] = 'protocol-assertion';
      } else if (/expected:[\s\S]*actual:/.test(message)) assertionKinds[record.id] = 'observation-mismatch';
      else if (causalPropertyAssertion(message)) assertionKinds[record.id] = 'causal-property';
      else throw new Error(`replay failure lacks observation or validated causal property evidence: ${record.id}`);
      assertionEvidence[record.id] = message;
    }
  }
  if (!cases.length) throw new Error('Rust harness report has no cases');
  const failingTests = cases.filter(record => record.status === 'failed').map(record => record.id);
  if (finish.cases !== cases.length) throw new Error('finish totals disagree with the case records');
  if (finish.failed !== failingTests.length) throw new Error('finish totals disagree with the failed cases');
  if (finish.status !== (failingTests.length ? 'failed' : 'passed')) throw new Error('finish status disagrees with the case records');
  if (exitCode === 0 && failingTests.length) throw new Error('harness exited 0 with failed cases');
  if (exitCode !== 0 && !failingTests.length) throw new Error(`harness exited ${exitCode} without a failed case: coverage or infrastructure failure`);
  return { state: failingTests.length ? 'detected' : 'survived', passed: cases.length - failingTests.length, failed: failingTests.length, failingTests, assertionKinds, assertionEvidence,
    executedTests: cases.map(record => record.id) };
}

function union(generated, fixed) {
  return { state: generated.failed + fixed.failed ? 'detected' : 'survived', passed: generated.passed + fixed.passed,
    failed: generated.failed + fixed.failed, failingTests: [...generated.failingTests, ...fixed.failingTests], components: ['generated', 'fixed'] };
}

// This native catalog is a deliberately smaller set than the current shared
// TypeScript/Go catalog. Record the gap instead of claiming complete coverage
// of its model-challenge boundary recordings.
export function rustMutationScope(catalog, typescript) {
  if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.mutations) || catalog.mutations.length < 13) throw new Error('expected versioned Rust fault catalog with its 13 baseline faults');
  const ids = new Set(), counterparts = new Set();
  for (const mutation of catalog.mutations) {
    if (!/^M\d+$/.test(mutation.id) || ids.has(mutation.id) || counterparts.has(mutation.typescriptMutation)) throw new Error('invalid/duplicate Rust mutation or counterpart ID');
    ids.add(mutation.id); counterparts.add(mutation.typescriptMutation);
    const counterpart = typescript.find(item => item.id === mutation.typescriptMutation);
    if (!counterpart || counterpart.case !== mutation.case) throw new Error(`invalid TypeScript counterpart ${mutation.id}`);
  }
  return { catalog: 'rust-native', modelBoundaryEvidence: false,
    mappedMutations: [...counterparts],
    unmappedSharedMutations: typescript.filter(item => !counterparts.has(item.id)).map(item => item.id) };
}

// Concurrent shards must never execute a sibling shard's mutated binaries.
// Keep the Cargo build cache separate by the same selection used for reports.
export function rustTargetDirectory(directory, selection) {
  return selectionDirectory(resolve(directory, 'rust/target/semantic'), selection);
}

export function measureRustSemantics({ shard = { index: 1, count: 1 }, only } = {}) {
  const language = languages.rust;
  const reportRoot = resolve(root, language.output);
  const selection = { shard, only };
  const output = selectionDirectory(reportRoot, selection);
  const started = Date.now();
  mkdirSync(reportRoot, { recursive: true });
  const report = { schemaVersion: 1, complete: false, ...(shard.count > 1 ? { shard: { index: shard.index, count: shard.count } } : {}), startedAt: new Date(started).toISOString(), baselines: {}, mutations: [] };
  const save = () => { report.elapsedSeconds = Math.round((Date.now() - started) / 1000); writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); };
  if (output !== reportRoot) {
    if (only === undefined) writeFileSync(resolve(reportRoot, 'report.json'), JSON.stringify({ schemaVersion: 1, complete: false, startedAt: report.startedAt }, null, 2) + '\n');
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
  }
  save();
  if (only === undefined) rmSync(resolve(reportRoot, 'report.md'), { force: true });
  const workspace = mkdtempSync(resolve(tmpdir(), 'dialcache-rust-semantic-'));
  const cargo = process.env.CARGO_BIN ?? 'cargo';
  // Bounds a hung mutant, not a slow runner: one release build of the crate
  // and its test binaries plus the 7,000-case replay take a few minutes on a
  // hosted runner. One timeout aborts the whole measurement.
  const timeout = 1_500_000;
  try {
    // Copies keep repo-relative paths while mutations stay outside the shared
    // checkout; the crate's build output is not an input and is not copied.
    // go/ is copied because a crate unit test compares the invalidation
    // script with go/internal/dialcache/redis_adapter.go byte for byte.
    for (const path of ['formal', 'typescript/test', 'typescript/src', 'go']) cpSync(resolve(root, path), resolve(workspace, path), { recursive: true });
    const target = resolve(root, 'rust/target');
    cpSync(resolve(root, 'rust'), resolve(workspace, 'rust'), { recursive: true, filter: source => source !== target && !source.startsWith(`${target}/`) });
    const crate = resolve(workspace, 'rust');
    const catalogPath = resolve(workspace, language.catalog);
    const catalog = json(catalogPath);
    const typescript = mutantsForPort(readMutantCatalog(path => readFileSync(resolve(workspace, path), 'utf8')), 'typescript');
    report.scope = rustMutationScope(catalog, typescript);
    report.sharedCatalogSha256 = hash(readFileSync(resolve(workspace, mutantCatalogPath)));
    const originals = new Map(), ids = new Set();
    for (const mutation of catalog.mutations) {
      if (!/^M\d+$/.test(mutation.id) || ids.has(mutation.id)) throw new Error('invalid/duplicate mutation ID');
      ids.add(mutation.id);
      if (!Array.isArray(mutation.edits) || !mutation.edits.length || !mutation.requiredDetections?.every(name => ['ordinary', 'generated', 'fixed', 'portable'].includes(name))) throw new Error(`invalid mutation ${mutation.id}`);
      for (const edit of mutation.edits) {
        if (!/^rust\/src\/[\w/-]+\.rs$/.test(edit.path) || !edit.before || edit.before === edit.after) throw new Error(`invalid production edit ${mutation.id}`);
        const original = readFileSync(resolve(workspace, edit.path), 'utf8');
        if (original.split(edit.before).length !== 2) throw new Error(`${mutation.id}: anchor must occur exactly once; review source drift in ${edit.path}`);
        originals.set(edit.path, original);
      }
    }
    const selected = selectMutations(catalog.mutations, selection);
    if (shard.count > 1) report.shard = { index: shard.index, count: shard.count, mutationIds: selected.map(m => m.id) };
    // Ordinary tests: the library's unit tests and every integration binary
    // that is not harness infrastructure, discovered from the crate so a new
    // native test file joins the cohort automatically.
    const ordinaryFiles = readdirSync(resolve(crate, 'tests')).filter(file => file.endsWith('.rs') && !infrastructureTestFile.test(file)).sort();
    if (!ordinaryFiles.length) throw new Error('no ordinary Rust integration tests found');
    const ordinaryTargets = ['--lib', ...ordinaryFiles.flatMap(file => ['--test', file.replace(/\.rs$/, '')])];
    const witnessDirectory = resolve(process.env.DIALCACHE_WITNESS_EVIDENCE_DIR ?? resolve(root, '.formal-traces/go-parity-witnesses'));
    const corpus = {
      DIALCACHE_MBT_TRACE_DIR: resolve(root, '.formal-traces/conformance'),
      DIALCACHE_EFFECTS_TRACE_DIR: resolve(root, '.formal-traces/effects'),
      DIALCACHE_FEATURE_TRACE_DIR: resolve(root, '.formal-traces/features'),
      DIALCACHE_WITNESS_EVIDENCE_DIR: witnessDirectory,
    };
    const cohorts = {
      ordinary: { targets: ordinaryTargets },
      generated: { suite: 'generated', protocolCorpus: 'generated', env: corpus },
      fixed: { suite: 'fixed', protocolCorpus: 'fixed', env: {} },
    };
    const env = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('DIALCACHE_')) delete env[name];
    // Dependencies build once and are shared by every mutant and run through
    // the checkout's cache directory; the crate copy itself lives at another
    // path, so cargo rebuilds exactly the crate and its tests per mutant.
    env.CARGO_TARGET_DIR = process.env.DIALCACHE_RUST_TARGET_DIR ?? rustTargetDirectory(root, selection);
    env.CARGO_TERM_COLOR = 'never';
    report.revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    report.cargo = spawnSync(cargo, ['--version'], { cwd: crate, encoding: 'utf8' }).stdout?.trim();
    report.node = process.version;
    report.catalogSha256 = hash(readFileSync(catalogPath));
    report.inputs = fingerprintFiles(workspace, language.inputs, { exclude: language.exclude });
    report.corpus = fingerprintFiles(root, ['.formal-traces/conformance', '.formal-traces/effects', '.formal-traces/features', '.formal-traces/regressions']);
    report.witnesses = fingerprintFiles(witnessDirectory, ['.']);
    report.sourceSha256 = Object.fromEntries([...originals].map(([path, text]) => [path, hash(text)]));
    report.selections = { ordinary: ['lib', ...ordinaryFiles.map(file => file.replace(/\.rs$/, ''))], generated: 'conformance harness: DIALCACHE_RUST_SUITE=generated over the complete corpus, witness evidence and generated vectors',
      fixed: 'conformance harness: DIALCACHE_RUST_SUITE=fixed over the fixed scenarios and checked-in vectors' };
    report.ordinaryFiles = ordinaryFiles;
    const spawnCargo = (args, extraEnv) => spawnSync(cargo, args, { cwd: crate, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout, maxBuffer: 256 * 1024 * 1024 });
    const compile = label => {
      const result = spawnCargo(['test', '--release', '--all-features', '--no-run']);
      writeFileSync(resolve(output, `${label}-compile.log`), (result.stdout ?? '') + (result.stderr ?? ''));
      if (result.error || result.signal || result.status !== 0) throw new Error(`${label}: noncompiling mutant/baseline, not detection; see compile log`);
    };
    const run = (label, cohort, baseline) => {
      let parsed;
      if (cohort === 'ordinary') {
        const result = spawnCargo(['test', '--release', '--all-features', '--no-fail-fast', ...cohorts.ordinary.targets]);
        writeFileSync(resolve(output, `${label}-${cohort}.log`), result.stdout ?? '');
        writeFileSync(resolve(output, `${label}-${cohort}.stderr.log`), result.stderr ?? '');
        if (result.error || result.signal) throw new Error(`${label}/${cohort}: runner infrastructure failed: ${result.error ?? result.signal}`);
        parsed = evaluateCargoTestOutput(result.stdout ?? '', result.status, 1 + ordinaryFiles.length);
      } else {
        const reportPath = resolve(output, `${label}-${cohort}.jsonl`);
        rmSync(reportPath, { force: true });
        const result = spawnCargo(['test', '--release', '--all-features', '--test', 'conformance'],
          { ...cohorts[cohort].env, DIALCACHE_RUST_SUITE: cohorts[cohort].suite, DIALCACHE_PROTOCOL_CORPUS: cohorts[cohort].protocolCorpus, DIALCACHE_RUST_REPORT: reportPath });
        writeFileSync(resolve(output, `${label}-${cohort}.log`), result.stdout ?? '');
        writeFileSync(resolve(output, `${label}-${cohort}.stderr.log`), result.stderr ?? '');
        if (result.error || result.signal) throw new Error(`${label}/${cohort}: runner infrastructure failed: ${result.error ?? result.signal}`);
        parsed = evaluateRustReport(existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '', result.status, result.stderr ?? '');
      }
      if (baseline && parsed.failed) throw new Error(`${cohort}: unmodified baseline must pass; see baseline log`);
      if (!baseline && JSON.stringify([...parsed.executedTests].sort()) !== JSON.stringify([...report.baselines[cohort].executedTests].sort())) throw new Error(`${label}/${cohort}: incomplete mutation run`);
      writeFileSync(resolve(output, `${label}-${cohort}.json`), JSON.stringify(parsed, null, 2) + '\n');
      return parsed;
    };
    // Every shard compiles and measures every baseline itself: its evidence
    // stands on the environment it ran in, and the merge refuses shards whose
    // baselines differ.
    compile('baseline');
    for (const cohort of Object.keys(cohorts)) {
      report.baselines[cohort] = run('baseline', cohort, true);
      console.log(`baseline ${cohort}: ${report.baselines[cohort].passed} passing tests`); save();
    }
    report.baselines.portable = union(report.baselines.generated, report.baselines.fixed);
    for (const mutation of selected) {
      const editedPaths = new Set();
      try {
        for (const edit of mutation.edits) {
          const path = resolve(workspace, edit.path), current = readFileSync(path, 'utf8');
          if (current.split(edit.before).length !== 2) throw new Error(`${mutation.id}: overlapping edits`);
          writeFileSync(path, current.replace(edit.before, edit.after)); editedPaths.add(edit.path);
        }
        compile(mutation.id);
        const result = { id: mutation.id, case: mutation.case, description: mutation.description, cohorts: {} };
        for (const cohort of Object.keys(cohorts)) result.cohorts[cohort] = run(mutation.id, cohort, false);
        result.cohorts.portable = union(result.cohorts.generated, result.cohorts.fixed);
        report.mutations.push(result);
        console.log(`${mutation.id}: ${Object.entries(result.cohorts).map(([name, value]) => `${name}=${value.state}(${value.failed})`).join(', ')}`); save();
      } finally { for (const path of editedPaths) writeFileSync(resolve(workspace, path), originals.get(path)); }
    }
    if (only) {
      // A filtered run is a local diagnostic, never evidence: it stays incomplete
      // and is not gated.
      report.partial = only;
      save();
      console.log(`Measured ${selected.length} selected mutations without gating: ${relative(root, output)}/report.json`);
      return report;
    }
    if (shard.count > 1) {
      gateDetections(language, report, selected, { directory: root, summarize: false });
      save();
      console.log(`Shard ${shard.index}/${shard.count} measured ${selected.length} mutations: ${relative(root, output)}/report.json; merge with node formal/merge-mutation-reports.mjs rust`);
      return report;
    }
    gateDetections(language, report, catalog.mutations, { directory: root });
    save();
    writeFileSync(resolve(output, 'report.md'), language.markdown(report));
    return report;
  } catch (error) { report.error = String(error); save(); throw error; }
  finally { rmSync(workspace, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    measureRustSemantics(selectionFromArguments(process.argv.slice(2)));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
