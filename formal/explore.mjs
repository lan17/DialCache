import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanEnvironment, executeSteps, validationPlan } from './validation.mjs';
import { nativeBinding } from './conformance-bindings.mjs';
import { parseTypeScriptReport } from './conformance-adapters.mjs';
import { checkGoReplay } from './check-go-replay.mjs';
import { checkRustReplay } from './check-rust-replay.mjs';
import { checkPythonReplay } from './check-python-replay.mjs';
import { canonicalSeed, reportFileName } from './witnesses.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (directory, path) => path.startsWith(directory + sep);
const reportPaths = { typescript: '.formal-traces/ts-replay.json', go: '.formal-traces/go-replay.jsonl', rust: '.formal-traces/rust-replay.jsonl', python: '.formal-traces/python-replay.jsonl' };
const contextPaths = { typescript: '.formal-traces/ts-context.json', go: '.formal-traces/go-context.json', rust: '.formal-traces/rust-context.json', python: '.formal-traces/python-context.json' };

export function explorationSeed(value = `0x${randomBytes(8).toString('hex')}`) {
  try { return canonicalSeed(value); }
  catch { throw new Error('Exploration seed must be an unsigned 64-bit integer.'); }
}

// Share model generation and native execution with acceptance. Exploration has
// its own report: a seed's missing witness must not prevent the other ports from
// executing the histories. No acceptance completion/adaptation step runs here.
export function explorationPlan(directory, seed, options = {}) {
  const normalized = explorationSeed(seed);
  return validationPlan('formal', { ...options, directory }).flatMap(step => {
    const script = step.args?.[0];
    // This campaign uses the manifest's pinned seed, not the exploration seed.
    // Full acceptance keeps it; exploration retains every unmodified model job.
    if (script === 'formal/check-model-properties.mjs') return [];
    if (step.remove || ['formal/conformance-adapters.mjs', 'formal/check-go-replay.mjs', 'formal/check-rust-replay.mjs', 'formal/check-python-replay.mjs'].includes(script)
      || script === 'formal/conformance.mjs' && step.args[1] === 'check') return [];
    if (script === 'formal/conformance.mjs' && step.args[1] === 'prepare') {
      return [{ label: `Prepare exploratory ${step.args[2]} context`, explorationContext: step.args[2] }];
    }
    if (script === 'formal/run-models.mjs') return [{ ...step, env: { ...step.env, QUINT_SEED: normalized } }];
    if (script === 'formal/run-python-replay.mjs') return [{ ...step, nativeReport: 'python' }];
    if (step.env?.DIALCACHE_MBT_TRACE_DIR) return [{ ...step, nativeReport: step.command === 'go' ? 'go' : step.command === 'cargo' ? 'rust' : 'typescript' }];
    // A seed's missing witness is classified by every native report. The shared
    // evaluator runs before native replay and still writes evidence for complete
    // profiles; its exit status must not stop any port from executing that
    // seed's histories.
    // The evaluator learns the corpus seed from the same variable run-models.mjs
    // reads, so its baseline gate applies the exploration rule to this seed.
    if (script === 'formal/witnesses.mjs') return [{ ...step, env: { ...step.env, QUINT_SEED: normalized }, tolerateFailure: true }];
    return [step];
  });
}

export function snapshotSources(directory, destination, paths) {
  const sourceRoot = realpathSync(directory);
  mkdirSync(destination, { recursive: true });
  const targetRoot = realpathSync(destination), fingerprints = {};
  for (const path of [...new Set(paths)].sort()) {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\')
      || path.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Invalid exploration source path: ${path}`);
    if (['.git', 'node_modules', '.formal-traces'].some(name => path === name || path.startsWith(name + '/'))) {
      throw new Error(`Generated/runtime inputs cannot enter the source snapshot: ${path}`);
    }
    let source = sourceRoot, missing = false;
    for (const part of path.split('/')) {
      source = resolve(source, part);
      let info;
      try { info = lstatSync(source); } catch (error) { if (error.code === 'ENOENT') { missing = true; break; } throw error; }
      // Reject even internal links: copying a link's target would change the
      // declared source inventory, and a dangling link is not a tracked deletion.
      if (info.isSymbolicLink()) throw new Error(`Symbolic link in exploration source: ${path}`);
    }
    if (missing) continue;
    if (!lstatSync(source).isFile()) throw new Error(`Exploration source is not a regular file: ${path}`);
    const target = resolve(targetRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    if (!inside(targetRoot, realpathSync(dirname(target))) && dirname(target) !== targetRoot) throw new Error('Exploration target leaves its snapshot.');
    copyFileSync(source, target, constants.COPYFILE_EXCL);
    fingerprints[path] = hash(readFileSync(target));
  }
  return fingerprints;
}

function verifyHashes(directory, groups) {
  for (const files of groups) for (const [path, expected] of Object.entries(files)) {
    const absolute = resolve(directory, path);
    if (!inside(realpathSync(directory), realpathSync(absolute)) || !lstatSync(absolute).isFile()
      || hash(readFileSync(absolute)) !== expected) throw new Error(`Exploration input changed: ${path}`);
  }
}

async function prepareExplorationContext(language, directory) {
  // Import from the snapshot so its own manifest, corpus and source inventory
  // define the context. A missing TS witness file is recorded as absent; it must
  // not prevent Go from executing that profile's histories.
  const { prepareContext, defaultSources } = await import(pathToFileURL(resolve(directory, 'formal/conformance.mjs')).href);
  const sources = defaultSources(language).filter(path => !path.startsWith('.formal-traces/go-parity-witnesses/') || existsSync(resolve(directory, path)));
  const context = { ...prepareContext(language, sources), kind: 'exploration' };
  writeFileSync(resolve(directory, contextPaths[language]), JSON.stringify(context, null, 2) + '\n');
  return context;
}

// Validate the original native report before assigning failure categories. The
// all-passed copy exists only in memory to reuse strict inventory/lifecycle
// validators; original statuses remain authoritative and are always retained.
export function nativeExplorationResult(language, text, context, directory, packageName) {
  if (context.kind !== 'exploration' || context.language !== language) throw new Error('Wrong exploratory native context.');
  const inventory = context.inventory, failed = [], otherFailures = [];
  let startedAt, finishedAt;
  if (language === 'typescript') {
    const original = JSON.parse(text), sanitized = structuredClone(original);
    if (!Array.isArray(original.testResults) || !original.testResults.length) throw new Error('Missing TypeScript native suites.');
    let passed = 0, failures = 0;
    const suites = new Set(), failedSuites = new Set();
    const cases = new Map(inventory.map(entry => [JSON.stringify(nativeBinding(entry, language, directory)), entry]));
    for (const [index, suite] of original.testResults.entries()) {
      if (!Array.isArray(suite.assertionResults) || !suite.assertionResults.length || !['passed', 'failed'].includes(suite.status)) throw new Error('Incomplete TypeScript suite.');
      let suiteFailures = 0;
      for (const [assertionIndex, assertion] of suite.assertionResults.entries()) {
        if (!['passed', 'failed'].includes(assertion.status)) throw new Error('Skipped or unfinished TypeScript assertion.');
        const key = JSON.stringify([suite.name.split(/[\\/]/).at(-1), assertion.fullName]);
        if (!Array.isArray(assertion.ancestorTitles)) throw new Error('Missing TypeScript suite hierarchy.');
        const parents = Array.from({ length: assertion.ancestorTitles.length + 1 }, (_, depth) =>
          JSON.stringify([suite.name, ...assertion.ancestorTitles.slice(0, depth)]));
        for (const parent of parents) suites.add(parent);
        if (assertion.status === 'failed') {
          if (!Array.isArray(assertion.failureMessages) || !assertion.failureMessages.length) throw new Error('Failed TypeScript assertion lacks evidence.');
          failures++; suiteFailures++;
          for (const parent of parents) failedSuites.add(parent);
          const entry = cases.get(key);
          if (entry) failed.push(entry); else otherFailures.push(assertion.fullName);
        } else {
          if (assertion.failureMessages?.length) throw new Error('Passed assertion contains errors.');
          passed++;
        }
        sanitized.testResults[index].assertionResults[assertionIndex] = { ...assertion, status: 'passed', failureMessages: [] };
      }
      if ((suite.status === 'failed') !== (suiteFailures > 0) || suite.message && !suiteFailures) throw new Error('TypeScript collection/runtime failure.');
      sanitized.testResults[index].status = 'passed';
      sanitized.testResults[index].message = '';
    }
    if (original.numPassedTests !== passed || original.numFailedTests !== failures || original.numTotalTests !== passed + failures
      || original.numTotalTestSuites !== suites.size || original.numFailedTestSuites !== failedSuites.size
      || original.numPassedTestSuites !== suites.size - failedSuites.size || original.success !== (failures === 0)) throw new Error('Inconsistent TypeScript native totals.');
    Object.assign(sanitized, { success: true, numFailedTests: 0, numFailedTestSuites: 0, numPassedTests: passed + failures });
    ({ startedAt, finishedAt } = parseTypeScriptReport(JSON.stringify(sanitized), inventory, directory));
  } else if (language === 'go') {
    const events = text.trim().split('\n').map(line => JSON.parse(line));
    const cases = new Map(inventory.map(entry => [nativeBinding(entry, language), entry]));
    const failedTests = events.filter(event => event.Action === 'fail' && event.Test).map(event => event.Test);
    for (const name of failedTests) {
      if (failedTests.some(other => other.startsWith(name + '/'))) continue; // Ancestor failure propagates a leaf's failure.
      const entry = cases.get(name);
      if (entry) failed.push(entry); else otherFailures.push(name);
    }
    if (events.some(event => event.Action === 'fail' && !event.Test) && !failedTests.length) throw new Error('Go package failed without a completed failing test.');
    if ((events.at(-1).Action === 'fail') !== (failedTests.length > 0)) throw new Error('Go package status disagrees with completed tests.');
    const profiles = Object.fromEntries(inventory.filter(entry => entry.category === 'sampled').map(entry => [entry.profile, 0]));
    for (const entry of inventory.filter(entry => entry.category === 'sampled')) profiles[entry.profile]++;
    const native = { packageName, profiles, witnessProfiles: inventory.filter(entry => entry.category === 'witness').map(entry => entry.profile),
      required: inventory.map(entry => ({ name: nativeBinding(entry, language), category: entry.category })) };
    checkGoReplay(events.map(event => JSON.stringify(event.Action === 'fail' ? { ...event, Action: 'pass' } : event)).join('\n'), native);
    startedAt = Date.parse(events[0].Time); finishedAt = Date.parse(events.at(-1).Time);
  } else if (language === 'rust' || language === 'python') {
    // These reports name cases by inventory id; a failed case record is the
    // native counterexample. The all-passed copy reuses the strict report gate.
    const records = text.trim().split('\n').map(line => JSON.parse(line));
    const cases = new Map(inventory.map(entry => [nativeBinding(entry, language), entry]));
    for (const record of records) {
      if (record.kind === 'case' && !['passed', 'failed'].includes(record.status)) throw new Error(`Skipped or unfinished ${language} case.`);
      if (record.kind !== 'case' || record.status !== 'failed') continue;
      const entry = cases.get(record.id);
      if (entry) failed.push(entry); else otherFailures.push(record.id);
    }
    const finish = records.at(-1);
    if (finish?.kind !== 'finish') throw new Error(`${language} report has no finish record: the harness crashed or timed out before completing.`);
    if (!['passed', 'failed'].includes(finish.status) || (finish.status === 'failed') !== (failed.length + otherFailures.length > 0)
      || finish.failed !== failed.length + otherFailures.length) throw new Error(`${language} report status disagrees with its case records.`);
    (language === 'rust' ? checkRustReplay : checkPythonReplay)(records.map(record => JSON.stringify(record.kind === 'case' ? { ...record, status: 'passed', message: undefined }
      : record.kind === 'finish' ? { ...record, status: 'passed', failed: 0 } : record)).join('\n'), inventory,
    language === 'python' ? { corpus: context.corpus } : undefined);
    startedAt = records[0]?.startedAt; finishedAt = finish.finishedAt;
  } else throw new Error('Unsupported exploratory port.');
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || startedAt < context.createdAt
    || finishedAt < startedAt || finishedAt > Date.now() + 60_000) throw new Error('Stale or invalid native report timestamps.');
  const witnessFailures = failed.filter(entry => entry.category === 'witness').map(entry => entry.id);
  const caseFailures = failed.filter(entry => entry.category !== 'witness').map(entry => entry.id);
  // A witness leaf can fail because reachability is missing OR its evidence is
  // invalid/unreadable. Preserve the raw error; neither alone is a native
  // behavioral counterexample, and neither should prevent the other replay.
  return { language, status: otherFailures.length ? 'infrastructure-failure' : caseFailures.length ? 'native-failure'
    : witnessFailures.length ? 'witness-check-failure' : 'passed', startedAt, finishedAt,
    cases: inventory.length, contextSha256: hash(JSON.stringify(context)), nativeReportSha256: hash(text), witnessFailures, caseFailures, otherFailures };
}

export async function runExplorationSteps(plan, { directory, environment = process.env, execute = executeSteps, onResult = () => {}, onToleratedFailure = () => {} } = {}) {
  const results = [];
  for (const step of plan) {
    if (step.explorationContext) { await prepareExplorationContext(step.explorationContext, directory); continue; }
    if (step.tolerateFailure) {
      try { await execute([step], { directory, environment }); }
      catch (error) {
        console.warn(`${step.label ?? 'Tolerated step'} failed; both native witness leaves record the shortfall and report.json keeps the witness report: ${error}`);
        onToleratedFailure(step, error);
      }
      continue;
    }
    if (!step.nativeReport) { await execute([step], { directory, environment }); continue; }
    const language = step.nativeReport, path = resolve(directory, reportPaths[language]);
    const contextPath = resolve(directory, contextPaths[language]);
    const contextText = readFileSync(contextPath, 'utf8'), context = JSON.parse(contextText);
    rmSync(path, { force: true }); // A crashed command cannot inherit an earlier report.
    let commandError;
    try { await execute([step], { directory, environment }); } catch (error) { commandError = String(error); }
    if (readFileSync(contextPath, 'utf8') !== contextText) throw new Error('Prepared exploration context changed during native execution.');
    const packageName = /^module\s+(\S+)\s*$/m.exec(readFileSync(resolve(directory, 'go/go.mod'), 'utf8'))?.[1];
    let result;
    try { result = nativeExplorationResult(language, readFileSync(path, 'utf8'), context, directory, packageName); }
    catch (cause) { throw new Error(`Invalid or missing ${language} native assertion report${commandError ? ` after ${commandError}` : ''}: ${cause}`, { cause }); }
    if (Boolean(commandError) !== (result.status !== 'passed')) throw new Error(`Native ${language} command status disagrees with its assertion report.`);
    verifyHashes(directory, [context.specification, context.implementation, context.corpus]);
    results.push({ ...result, ...(commandError ? { commandError } : {}) }); onResult(results);
    if (result.status === 'infrastructure-failure') throw new Error(`Exploratory ${language} infrastructure checks failed.`);
  }
  return results;
}

function savedExploration(path) {
  const reportPath = realpathSync(path), text = readFileSync(reportPath, 'utf8');
  const report = JSON.parse(text);
  if (report.schemaVersion !== 1 || report.kind !== 'exploration' || report.acceptance !== false
    || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(report.baseRevision ?? '')
    || !Number.isFinite(Date.parse(report.finishedAt))
    || !['passed', 'native-failure', 'witness-check-failure', 'coverage-gate-failure', 'infrastructure-failure'].includes(report.status)
    || !report.sources || Array.isArray(report.sources) || !Object.keys(report.sources).length
    || Object.values(report.sources).some(value => typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value))) {
    throw new Error('Expected a finished exploratory report with a source inventory and base revision.');
  }
  const seed = explorationSeed(report.seed);
  if (seed !== report.seed) throw new Error('Saved exploration seed is missing or not canonical.');
  const workspace = resolve(dirname(reportPath), 'workspace');
  verifyHashes(workspace, [report.sources]);
  return { reportPath, reportSha256: hash(text), seed, baseRevision: report.baseRevision,
    workspace, sources: report.sources };
}

function linkDependencies(directory, workspace, sources, replay) {
  if (replay) for (const path of ['package.json', 'pnpm-lock.yaml', ...(Object.hasOwn(sources, 'python/pyproject.toml') ? ['python/pyproject.toml'] : [])]) {
    if (!Object.hasOwn(sources, path) || hash(readFileSync(resolve(directory, path))) !== sources[path]) {
      throw new Error(`Saved ${path} differs from the current dependency runtime; replay requires matching dependency manifest bytes.`);
    }
  }
  symlinkSync(resolve(directory, 'node_modules'), resolve(workspace, 'node_modules'), 'dir');
}

export async function explore(seed, options = {}) {
  return executeExploration(explorationSeed(seed), options);
}

export async function replayExploration(path, options = {}) {
  const origin = savedExploration(path);
  return executeExploration(origin.seed, { ...options, origin });
}

function loadWitnessReport(workspace, report) {
  const witnessReport = resolve(workspace, `.formal-traces/${reportFileName}`);
  if (!existsSync(witnessReport)) return;
  try { report.witnesses = JSON.parse(readFileSync(witnessReport, 'utf8')); }
  catch (error) { report.witnesses = { error: String(error) }; }
}

// The witness profiles a snapshot schedules: its own manifest filtered by its
// own registry. A saved run is judged against the inventory it was saved with,
// not against a checkout that may have gained or lost profiles since.
export function snapshotWitnessProfiles(workspace) {
  const manifest = resolve(workspace, 'formal/execution.json'), registry = resolve(workspace, 'formal/coverage-witnesses.json');
  if (!existsSync(manifest) || !existsSync(registry)) return undefined;
  const models = JSON.parse(readFileSync(manifest, 'utf8')).models ?? [];
  const witnessed = new Set(Object.keys(JSON.parse(readFileSync(registry, 'utf8'))));
  return models.map(model => model.profile).filter(profile => typeof profile === 'string' && witnessed.has(profile));
}

// A completed evaluator report for this seed: the tolerated step may have died
// after writing per-profile evidence but before the aggregate, and both ports
// can still pass on that evidence. Missing or malformed coverage evidence is
// never a clean gate, and neither is a report judged under another seed or
// covering fewer profiles than the manifest schedules.
export function witnessReportProblem(witnesses, seed, expectedProfiles) {
  if (expectedProfiles === undefined) return 'the snapshot has no witness inventory (formal/execution.json and formal/coverage-witnesses.json)';
  if (witnesses === undefined) return 'the witness evaluator wrote no report';
  if (witnesses.error !== undefined) return `the witness report is unreadable: ${witnesses.error}`;
  if (witnesses.schemaVersion !== 1 || witnesses.command !== 'evaluate' || !Array.isArray(witnesses.failed) || !Array.isArray(witnesses.incomplete)
    || typeof witnesses.profiles !== 'object' || witnesses.profiles === null || Array.isArray(witnesses.profiles) || typeof witnesses.seed !== 'string') {
    return 'the witness report is not a completed evaluation';
  }
  let reportSeed;
  try { reportSeed = canonicalSeed(witnesses.seed); } catch { return `the witness report carries an invalid seed ${JSON.stringify(witnesses.seed)}`; }
  if (reportSeed !== seed) return `the witness report was judged under seed ${reportSeed}, not this exploration's ${seed}`;
  const missing = expectedProfiles.filter(profile => !(profile in witnesses.profiles));
  if (missing.length) return `the witness report covers no evaluation of ${missing.join(', ')}`;
  return undefined;
}

async function executeExploration(seed, { directory = root, environment = process.env, run, origin } = {}) {
  const selectedSeed = explorationSeed(seed);
  const parent = resolve(directory, '.formal-traces/exploration');
  mkdirSync(parent, { recursive: true });
  const output = mkdtempSync(resolve(parent, `${selectedSeed}-`)), workspace = resolve(output, 'workspace');
  // Reuse only the dependency interpreter. The runner prepends its own source
  // tree; the prerequisite probe also imports the snapshot, never an editable
  // installation's original checkout. A virtualenv is not copied into evidence.
  const runtimeEnvironment = { ...environment,
    PYTHON: environment.PYTHON ?? resolve(directory, 'python/.venv/bin/python'),
    PYTHONPATH: resolve(workspace, 'python') };
  const report = { schemaVersion: 1, kind: 'exploration', acceptance: false, seed: selectedSeed,
    status: 'running', startedAt: new Date().toISOString(), sources: {}, native: [],
    ...(origin ? { replayOrigin: { path: origin.reportPath, reportSha256: origin.reportSha256,
      baseRevision: origin.baseRevision, sourcesSha256: hash(JSON.stringify(origin.sources)) } } : {}) };
  const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  let dependencyLink = false;
  try {
    if (origin) {
      // No Git discovery: a saved workspace has its own declared bytes and may
      // no longer belong to the original checkout. Copying also rejects links.
      report.baseRevision = origin.baseRevision;
      report.sources = snapshotSources(origin.workspace, workspace, Object.keys(origin.sources));
      if (Object.keys(report.sources).length !== Object.keys(origin.sources).length) throw new Error('Saved exploration source was deleted while copying.');
      verifyHashes(workspace, [origin.sources]);
      if (hash(readFileSync(origin.reportPath)) !== origin.reportSha256) throw new Error('Saved exploration report changed while copying.');
    } else {
      const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      report.baseRevision = git(['rev-parse', 'HEAD']).trim();
      const paths = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
      report.sources = snapshotSources(directory, workspace, paths);
    }
    save();
    linkDependencies(directory, workspace, report.sources, Boolean(origin)); dependencyLink = true;
    console.log(`Exploratory seed ${selectedSeed}; sources and native evidence: ${output}`);
    const quotedReport = `'${resolve(output, 'report.json').replaceAll("'", "'\\''")}'`;
    console.log(`Reproduce saved source bytes: node formal/explore.mjs --replay ${quotedReport}`);
    // Load the copied runner, plan and prerequisite checks. A newer checkout's
    // behavior must not silently replace the implementation being reproduced.
    const snapshot = run ? { explorationPlan, runExplorationSteps: run }
      : await import(pathToFileURL(resolve(workspace, 'formal/explore.mjs')).href);
    if (!run) {
      const validation = await import(pathToFileURL(resolve(workspace, 'formal/validation.mjs')).href);
      validation.checkPrerequisites('explore', { directory: workspace, environment: cleanEnvironment(runtimeEnvironment) });
    }
    report.native = await snapshot.runExplorationSteps(snapshot.explorationPlan(workspace, selectedSeed, { environment: runtimeEnvironment }), {
      directory: workspace, environment: cleanEnvironment(runtimeEnvironment), onResult: results => { report.native = results; save(); },
      // The evaluator step is tolerated so both ports replay; its failure is
      // still part of the record so a missing report explains itself.
      onToleratedFailure: (step, error) => { report.witnessStepError = `${step.label ?? 'tolerated step'}: ${error}`; save(); },
    });
    verifyHashes(workspace, [report.sources]);
    report.sourcesUnchanged = true;
    if (report.native.map(result => result.language).sort().join() !== Object.keys(reportPaths).sort().join()
      || report.native.some(result => !['passed', 'native-failure', 'witness-check-failure'].includes(result.status))) {
      throw new Error('Exploration did not finish every native port.');
    }
    // The witness step is tolerated so both ports replay, but its baseline
    // gate still decides the outcome afterwards: a fresh seed whose sampled
    // hits fell below the recorded tolerance is an exploration-quality failure
    // even when every required label is present and both ports pass.
    loadWitnessReport(workspace, report);
    const nativeStatus = report.native.some(result => result.status === 'native-failure') ? 'native-failure'
      : report.native.some(result => result.status === 'witness-check-failure') ? 'witness-check-failure' : undefined;
    const problem = witnessReportProblem(report.witnesses, selectedSeed, snapshotWitnessProfiles(workspace));
    if (nativeStatus === undefined && problem !== undefined) {
      report.status = 'infrastructure-failure';
      throw new Error(`Exploration cannot be accepted: ${problem}, so the coverage gate has no evidence although both ports passed.`);
    }
    const coverageGate = problem === undefined ? [...report.witnesses.incomplete, ...report.witnesses.failed] : [];
    report.status = nativeStatus ?? (coverageGate.length ? 'coverage-gate-failure' : 'passed');
    if (report.status === 'coverage-gate-failure') throw new Error(`Exploration finished with coverage-gate-failure; the witness gate reported:\n${coverageGate.join('\n')}`);
    if (report.status !== 'passed') throw new Error(`Exploration finished with ${report.status}; inspect both native reports.`);
  } catch (error) {
    if (report.status === 'running') report.status = 'infrastructure-failure';
    report.error = String(error); throw error;
  } finally {
    // The tolerated witness step leaves its fragility report and baseline gate
    // result in the workspace; keep them with the exploration report so a
    // fresh seed's sampled-count drop stays visible even when the step failed.
    if (report.witnesses === undefined) loadWitnessReport(workspace, report);
    // Unlink only the known runtime link. Initialization errors also receive a
    // finished report and cannot leave a permanently "running" artifact.
    let cleanupError;
    try { if (dependencyLink) unlinkSync(resolve(workspace, 'node_modules')); }
    catch (error) { cleanupError = error; report.status = 'infrastructure-failure'; report.cleanupError = String(error); }
    report.finishedAt = new Date().toISOString(); save();
    if (cleanupError) throw cleanupError;
  }
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || !['--seed', '--replay'].includes(args[0]))) {
    throw new Error('Usage: node formal/explore.mjs [--seed <uint64> | --replay <saved-report.json>]');
  }
  if (args[0] === '--replay') await replayExploration(args[1]);
  else await explore(args[1]);
}
