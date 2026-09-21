import { startRedisVectorServer } from './redis-vector-server.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { boundaryEvidence, checkMutantAnchors, mutantsForPort, readMutantCatalog } from './execution.mjs';
import { assessBoundary, classifyCohort, fingerprintFiles, finishPartial, gateDetections, languages, noncompilingResult, portableCohort, selectMutations, selectionDirectory, selectionFromArguments } from './mutation-reports.mjs';
import { boundaryBaselines, boundaryTrace, mutationBoundaries, runBoundaryReplay } from './boundary-replay.mjs';
import { settlementViolationPattern } from './replay/settlement.mjs';

// The whole output line that carries a settlement violation. Anchored per
// line so a multi-kilobyte expected/actual line costs a linear scan.
const violationLine = new RegExp(`^.*${settlementViolationPattern.source}.*$`, 'm');

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
const protocolNames = ['TestProtocolKeys', 'TestProtocolFrames', 'TestProtocolDecoders', 'TestProtocolCohorts', 'TestProtocolRemainingVectors'];
const generatedNames = ['TestGeneratedInvalidationVectors', 'TestCoreConformance', 'TestEffectsConformance', 'TestFeatureConformance', 'TestLocalClockConformance', 'TestGeneratedWitnessEvidence', ...protocolNames];
const fixedNames = ['TestBehaviorConformance', ...protocolNames];
const infrastructureTestFile = /(?:replay|driver|coordinator|protocol|profile|registry|witness_evidence|integration)_test\.go$/;

// The monitor emits this discriminator only after validating its journal.
// Match explicit rule/event schemas; generic monitor errors remain failures of
// the measurement rather than evidence that a production mutation was caught.
export function causalPropertyAssertion(output) {
  const match = /CAUSAL_PROPERTY_FAILURE rule=(C23|C25|C26) event=(\{[^\r\n]*\})/.exec(output);
  if (!match) return false;
  let event;
  try { event = JSON.parse(match[2]); } catch { return false; }
  const nonnegative = value => Number.isFinite(value) && value >= 0;
  const index = value => Number.isSafeInteger(value) && value >= 0;
  if (!event || !index(event.index) || !index(event.atMs)) return false;
  const condition = `${match[1]}:${event.event}:${event.condition}`;
  switch (condition) {
    case 'C23:fallbackCompletion:duration includes lookup or omits source time':
      return nonnegative(event.elapsedMs) && nonnegative(event.durationMs) && Math.abs(event.durationMs - event.elapsedMs) > 1e-7;
    case 'C23:fallbackCompletion:source lost its full source-relative budget':
      return event.failed === true && nonnegative(event.elapsedMs) && event.budgetMs > 0 && event.elapsedMs < event.budgetMs && ['', 'resolve'].includes(event.settlement);
    case 'C25:fallbackCompletion:success must be accepted before its source deadline':
      return event.failed === false && nonnegative(event.elapsedMs) && event.budgetMs > 0 && ['', 'resolve', 'reject'].includes(event.settlement) && (event.elapsedMs >= event.budgetMs || event.settlement !== 'resolve');
    case 'C26:writeDispatch:publication without accepted source success':
      return event.authorized === false;
    case "C26:writeDispatch:write belongs to a different invocation's source":
      return index(event.source) && index(event.owner) && index(event.sourceOwner) && event.owner !== event.sourceOwner;
    case "C26:writeDispatch:write requires that exact source's successful settlement":
      return index(event.source) && index(event.owner) && ['', 'reject'].includes(event.outcome);
    case 'C25:writeDispatch:late raw settlement cannot authorize publication':
      return index(event.source) && index(event.owner) && index(event.startedAtMs) && index(event.settledAtMs) && event.budgetMs > 0 && event.settledAtMs - event.startedAtMs >= event.budgetMs;
    default: return false;
  }
}

// A compiler error, test crash, deadlock, timeout, skipped test, missing package
// completion, or failing corpus audit is not an assertion-based detection.
export function evaluateGoTestEvents(lines, exitCode) {
  const events = lines.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (lines.includes('INVALIDATION_INFRASTRUCTURE:')) throw new Error('Redis vector infrastructure failure, not detection');
  if (!events.length) throw new Error('empty Go test event stream');
  const outputs = new Map(), tests = new Map(), packages = [];
  const append = (name, value) => outputs.set(name, (outputs.get(name) ?? '') + value);
  for (const event of events) {
    if (event.Output) append(event.Test ?? '', event.Output);
    if (event.Test && event.Action === 'run') {
      if (tests.has(event.Test)) throw new Error(`duplicate test execution ${event.Test}`);
      tests.set(event.Test, 'running');
    }
    if (event.Test && ['pass', 'fail', 'skip'].includes(event.Action)) {
      if (!tests.has(event.Test) || tests.get(event.Test) !== 'running') throw new Error(`unexpected completion ${event.Test}`);
      tests.set(event.Test, event.Action);
    }
    if (!event.Test && ['pass', 'fail', 'skip'].includes(event.Action)) packages.push(event.Action);
    if (event.Action === 'build-fail') throw new Error('Go package build failed');
  }
  const allOutput = [...outputs.values()].join('\n');
  if (/panic:|fatal error:|runtime error:|test timed out|all goroutines are asleep|DATA RACE|\[build failed\]/i.test(allOutput)) {
    throw new Error('crash, timeout, race, or build error is not mutation detection');
  }
  if (packages.length !== 1 || packages[0] === 'skip' || [...tests.values()].some(state => state === 'skip' || state === 'running')) {
    throw new Error('incomplete or skipped Go test execution');
  }
  const names = [...tests.keys()];
  const leaves = names.filter(name => !names.some(other => other.startsWith(`${name}/`)));
  if (!leaves.length) throw new Error('no executed assertion tests');
  const failedLeaves = leaves.filter(name => tests.get(name) === 'fail');
  const failures = names.filter(name => tests.get(name) === 'fail');
  const assertionKinds = {};
  for (const name of failures) {
    if (!failedLeaves.some(leaf => leaf === name || leaf.startsWith(`${name}/`))) throw new Error(`non-assertion parent failure ${name}`);
    if (name.startsWith('TestGeneratedWitnessEvidence')) throw new Error(`witness audit failure ${name}`);
  }
  for (const name of failedLeaves) {
    const output = outputs.get(name) ?? '';
    if (!/\b[\w-]+_test\.go:\d+:/.test(output)) throw new Error(`failure has no assertion location: ${name}`);
    if (/^Test(?:Core|Effects|Feature|Behavior|LocalClock)Conformance(?:\/|$)/.test(name)) {
      // A settlement violation is the coordinator's verdict on the driver's
      // receipt, never comparison evidence about the cache. The violating line
      // travels with the error so the runner records a mutant's cohort against
      // it by name (mutation-reports.mjs classifyCohort) instead of crediting
      // or discounting it.
      const violation = violationLine.exec(output);
      if (violation !== null) {
        const error = new Error(`settlement violation under mutation is not comparison evidence: ${name}`);
        error.settlementViolation = violation[0].trim();
        throw error;
      }
      if (/expected:[\s\S]*actual:/.test(output)) assertionKinds[name] = 'observation-mismatch';
      else if (causalPropertyAssertion(output)) assertionKinds[name] = 'causal-property';
      // The core replay asserts that a coalesced pair (or a request pair)
      // returns one value before it records the pair's observation; those two
      // assertions carry no expected/actual pair, so they are recognized by
      // their exact text.
      else if (/core_replay_test\.go:\d+: (?:pair returned different values|request pair differs)/.test(output)) assertionKinds[name] = 'pair-value-mismatch';
      else throw new Error(`replay failure lacks observation or validated causal property evidence: ${name}`);
    } else {
      assertionKinds[name] = 'native-assertion';
    }
  }
  const failed = failedLeaves.length;
  if (exitCode !== (failed ? 1 : 0) || packages[0] !== (failed ? 'fail' : 'pass')) throw new Error('Go exit code and assertion results disagree');
  return { state: failed ? 'detected' : 'survived', passed: leaves.length - failed, failed,
    failingTests: failedLeaves, assertionKinds, assertionEvidence: Object.fromEntries(failedLeaves.map(name => [name, outputs.get(name)])),
    executedTests: leaves };
}

// --shard=<index>/<count> measures a contiguous slice of the catalog after the
// compile check and the full baselines; --only=<id>,<id> measures the named
// mutants into a partial report that is never complete evidence; the default
// is the complete single-process measurement.
export function measureGoSemantics({ shard = { index: 1, count: 1 }, only } = {}) {
  const language = languages.go;
  const reportRoot = resolve(root, language.output);
  const output = selectionDirectory(reportRoot, { shard, only });
  const started = Date.now();
  mkdirSync(reportRoot, { recursive: true });
  const report = { schemaVersion: 1, complete: false, ...(only ? { partial: true, only } : shard.count > 1 ? { shard: { index: shard.index, count: shard.count } } : {}), startedAt: new Date(started).toISOString(), baselines: {}, mutations: [] };
  const save = () => { report.elapsedSeconds = Math.round((Date.now() - started) / 1000); writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n'); };
  if (only) {
    // A partial run leaves the complete report and the shards alone.
    rmSync(output, { recursive: true, force: true });
    mkdirSync(output, { recursive: true });
    save();
  } else {
    // Invalidate old completion before loading catalog, dependencies, or evidence.
    // A shard also invalidates the merged report above it, which is evidence only
    // while every shard beneath it is current.
    if (output !== reportRoot) {
      writeFileSync(resolve(reportRoot, 'report.json'), JSON.stringify({ schemaVersion: 1, complete: false, startedAt: report.startedAt }, null, 2) + '\n');
      rmSync(output, { recursive: true, force: true });
      mkdirSync(output, { recursive: true });
    }
    save(); rmSync(resolve(reportRoot, 'report.md'), { force: true });
  }
  const workspace = mkdtempSync(resolve(tmpdir(), 'dialcache-go-semantic-'));
  const go = process.env.GO_BIN ?? 'go';
  // Bounds a hung mutant, not a slow runner: hosted runners vary by about
  // 2x between runs (run 34660598461 replayed the generated cohort in 104 s;
  // run 34666226055 had not finished it after 150 s). One timeout aborts the
  // whole measurement, so a generous bound costs at most one wait.
  const timeout = 540_000;
  let vectorServer;
  try {
    // Copies preserve repo-relative witness definition paths while mutations
    // remain completely outside the shared checkout. No git resets or writes
    // touch the user's implementation or trace corpus.
    for (const path of ['formal', 'go', 'test', 'src']) cpSync(resolve(root, path), resolve(workspace, path), { recursive: true });
    const moduleDirectory = resolve(workspace, 'go');
    const catalogPath = resolve(workspace, language.catalog);
    // The catalog is validated and every anchor checked in the workspace copy by
    // the one implementation the audit uses; the originals restore the
    // workspace after each mutant.
    const readWorkspace = path => readFileSync(resolve(workspace, path), 'utf8');
    const mutantCatalog = readMutantCatalog(readWorkspace);
    const originals = checkMutantAnchors(mutantCatalog, readWorkspace);
    const catalog = { mutations: mutantsForPort(mutantCatalog, language.port) };
    const selected = selectMutations(catalog.mutations, { shard, only });
    const evidence = boundaryEvidence().filter(entry => selected.some(mutation => mutation.id === entry.mutant));
    if (!only && shard.count > 1) report.shard = { index: shard.index, count: shard.count, mutationIds: selected.map(m => m.id) };
    const ordinaryFiles = readdirSync(moduleDirectory).filter(file => file.endsWith('_test.go') && !infrastructureTestFile.test(file)).sort();
    const ordinary = ordinaryFiles.flatMap(file => [...readFileSync(resolve(moduleDirectory, file), 'utf8').matchAll(/^func (Test\w+)\(t \*testing\.T\)/gm)].map(match => match[1]));
    if (!ordinary.length || new Set(ordinary).size !== ordinary.length) throw new Error('invalid ordinary Go test selection');
    const cohorts = { ordinary, generated: generatedNames, fixed: fixedNames };
    const env = { ...process.env };
    const witnessDirectory = resolve(process.env.DIALCACHE_WITNESS_EVIDENCE_DIR ?? resolve(root, '.formal-traces/go-parity-witnesses'));
    for (const name of Object.keys(env)) if (name.startsWith('DIALCACHE_')) delete env[name];
    Object.assign(env, {
      DIALCACHE_MBT_TRACE_DIR: resolve(root, '.formal-traces/conformance'),
      DIALCACHE_EFFECTS_TRACE_DIR: resolve(root, '.formal-traces/effects'),
      DIALCACHE_FEATURE_TRACE_DIR: resolve(root, '.formal-traces/features'),
      DIALCACHE_WITNESS_EVIDENCE_DIR: witnessDirectory,
    });
    vectorServer = startRedisVectorServer();
    env.DIALCACHE_VECTOR_REDIS_URL = vectorServer.url;
    report.redisVectorImage = vectorServer.image;
    const replayBoundary = (label, history) => runBoundaryReplay({
      port: language.port, history, label, output, root, workspace, env, go,
    });
    const boundaries = (id, replay = history => replayBoundary(id, history)) =>
      mutationBoundaries(evidence.filter(entry => entry.mutant === id), replay, assessBoundary);
    report.revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim();
    report.go = spawnSync(go, ['version'], { cwd: moduleDirectory, encoding: 'utf8' }).stdout?.trim();
    report.node = process.version;
    report.catalogSha256 = hash(readFileSync(catalogPath));
    report.inputs = fingerprintFiles(workspace, language.inputs);
    report.corpus = fingerprintFiles(root, ['.formal-traces/conformance', '.formal-traces/effects', '.formal-traces/features', '.formal-traces/regressions']);
    report.witnesses = fingerprintFiles(witnessDirectory, ['.']);
    report.sourceSha256 = Object.fromEntries([...originals].filter(([path]) => path.startsWith('go/')).map(([path, text]) => [path, hash(text)]));
    report.selections = cohorts;
    report.ordinaryFiles = ordinaryFiles;
    const compile = label => {
      const result = spawnSync(go, ['test', '-run', '^$', '-count=1', '.'], { cwd: moduleDirectory, env, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
      writeFileSync(resolve(output, `${label}-compile.log`), (result.stdout ?? '') + (result.stderr ?? ''));
      // A compiler that could not run is infrastructure; one that rejected the edit is a noncompiling mutant.
      if (result.error || result.signal) throw new Error(`${label}: compile step failed to run: ${result.error ?? result.signal}`);
      if (result.status !== 0) throw new Error(`${label}: noncompiling mutant/baseline, not detection; see compile log`);
    };
    const run = (label, cohort, baseline) => {
      // Faults can make instance state process-global. Keep independent
      // synctest histories isolated; separate mutation shards still parallelize.
      const result = spawnSync(go, ['test', '-json', '-count=1', '-parallel=1', '-timeout=480s', '-run', `^(${cohorts[cohort].join('|')})$`, '.'], {
        cwd: moduleDirectory, env: { ...env, DIALCACHE_PROTOCOL_CORPUS: cohort === 'generated' ? 'generated' : 'fixed' }, encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024,
      });
      writeFileSync(resolve(output, `${label}-${cohort}.jsonl`), result.stdout ?? '');
      writeFileSync(resolve(output, `${label}-${cohort}.stderr.log`), result.stderr ?? '');
      if (result.error || result.signal) throw new Error(`${label}/${cohort}: runner infrastructure failed: ${result.error ?? result.signal}`);
      // A hung cohort is a measurement bound, not a crash the fault explains: it
      // ends the shard, which is what the shard budget assumes.
      if (/panic: test timed out/.test(result.stdout ?? '')) throw new Error(`${label}/${cohort}: go test hit its timeout; a hung cohort is not measured`);
      const parsed = classifyCohort({ baseline, cohort }, () => evaluateGoTestEvents(result.stdout, result.status));
      if (parsed.state === 'crashed') {
        // Name the panic or the failing test so the report stands on its own.
        const cause = /panic: [^"\\]+|fatal error: [^"\\]+|--- FAIL: \S+/.exec(result.stdout ?? '')?.[0];
        if (cause) parsed.reason = `${parsed.reason} (${cause.trim()})`;
        writeFileSync(resolve(output, `${label}-${cohort}.json`), JSON.stringify(parsed, null, 2) + '\n');
        return parsed;
      }
      if (baseline && parsed.failed) throw new Error(`${cohort}: unmodified baseline must pass; see baseline event log`);
      const currentTop = new Set(parsed.executedTests.map(name => name.split('/')[0]));
      if (cohorts[cohort].some(name => !currentTop.has(name))) throw new Error(`${label}/${cohort}: missing selected test`);
      if (!baseline && parsed.state === 'survived' && JSON.stringify([...parsed.executedTests].sort()) !== JSON.stringify([...report.baselines[cohort].executedTests].sort())) throw new Error(`${label}/${cohort}: incomplete surviving run`);
      writeFileSync(resolve(output, `${label}-${cohort}.json`), JSON.stringify(parsed, null, 2) + '\n');
      return parsed;
    };
    // Every shard compiles and measures every baseline itself: its evidence
    // stands on the environment it ran in, and the merge refuses shards whose
    // baselines differ.
    compile('baseline');
    for (const cohort of Object.keys(cohorts)) {
      report.baselines[cohort] = run('baseline', cohort, true);
      console.log(`baseline ${cohort}: ${report.baselines[cohort].passed} passing leaf tests`); save();
    }
    report.baselines.portable = portableCohort(report.baselines.generated, report.baselines.fixed);
    report.boundaryBaselines = boundaryBaselines(evidence, history => replayBoundary('baseline', history));
    save();
    for (const mutation of selected) {
      const editedPaths = new Set();
      try {
        // The replacement is a function so a `$` in the edit text is literal.
        for (const edit of mutation.edits) {
          const path = resolve(workspace, edit.path), current = readFileSync(path, 'utf8');
          if (current.split(edit.before).length !== 2) throw new Error(`${mutation.id}: overlapping edits in ${edit.path}`);
          writeFileSync(path, current.replace(edit.before, () => edit.after)); editedPaths.add(edit.path);
        }
        try { compile(mutation.id); } catch (error) {
          // Recorded, never measured: the gate names the mutant while the rest
          // of the shard is still measured.
          const result = noncompilingResult(mutation, [...Object.keys(cohorts), 'portable'], error.message);
          result.boundary = boundaries(mutation.id, history => ({ path: boundaryTrace(history, resolve(root, '.formal-traces')).path,
            completed: false, lastStep: -1, divergences: [], error: error.message }));
          report.mutations.push(result);
          console.log(`${mutation.id}: noncompiling`); save();
          continue;
        }
        const result = { id: mutation.id, case: mutation.case, description: mutation.description, cohorts: {} };
        for (const cohort of Object.keys(cohorts)) result.cohorts[cohort] = run(mutation.id, cohort, false);
        result.cohorts.portable = portableCohort(result.cohorts.generated, result.cohorts.fixed);
        result.boundary = boundaries(mutation.id);
        report.mutations.push(result);
        console.log(`${mutation.id}: ${Object.entries(result.cohorts).map(([name, value]) => `${name}=${value.state}(${value.failed})`).join(', ')}`); save();
      } finally { for (const path of editedPaths) writeFileSync(resolve(workspace, path), originals.get(path)); }
    }
    if (only) return finishPartial(report, selected, { output: relative(root, output), save });
    if (shard.count > 1) {
      // A shard gates its own slice and stays incomplete; the merge recomputes
      // the gate and the detection summary over the whole catalog.
      gateDetections(language, report, selected, { directory: root, summarize: false });
      save();
      console.log(`Shard ${shard.index}/${shard.count} measured ${selected.length} mutations: ${relative(root, output)}/report.json; merge with node formal/merge-mutation-reports.mjs go`);
      return report;
    }
    gateDetections(language, report, catalog.mutations, { directory: root });
    save();
    writeFileSync(resolve(output, 'report.md'), language.markdown(report));
    return report;
  } catch (error) { report.error = String(error); save(); throw error; }
  finally {
    rmSync(workspace, { recursive: true, force: true });
    vectorServer?.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { measureGoSemantics(selectionFromArguments(process.argv.slice(2))); } catch (error) { console.error(error); process.exitCode = 1; }
}
