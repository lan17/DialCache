import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { constrainAction } from './generated-fixtures.mjs';
import { normalizeReplayInputs } from './replay-inputs.mjs';
import { bindTrace } from './replay/bindings.mjs';
import { parseTrace as parseEffects, expectedObservations } from './replay/effects.mjs';
import { parseTrace as parseFeatures, profiles } from './replay/features.mjs';
import { parseTypeScriptReport } from './conformance-adapters.mjs';
import { checkGoReplay } from './check-go-replay.mjs';
import { nativeBinding } from './conformance-bindings.mjs';
import { defaultSources } from './conformance.mjs';
import { cleanEnvironment } from './validation.mjs';
import { spawnBuffered } from './quint-pool.mjs';
import { validatePropertyResult } from './check-model-properties.mjs';
import { indexModules, lintThinProfile, lintWitnessIsolation } from './lint-profiles.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const catalogPath = 'formal/kernel/pilot.json';
const challengePath = 'formal/kernel/challenges.json';
const outputPath = '.formal-traces/kernel-pilot';
const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
const save = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); };
const digest = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z_]\w*$/.test(value);
export const pilotInvariants = ['oneRegisteredFlightPerIdentity', 'publicationHasTimelySource', 'finishedOwnersHaveFinishedCallers',
  'registeredExecutionsHavePendingCallers', 'closedScopesHaveNoMemo'];

export function validatePilot(catalog) {
  if (catalog?.schemaVersion !== 1 || !catalog.profiles || Object.keys(catalog.profiles).sort().join() !== 'effects,layers'
    || !Array.isArray(catalog.histories) || !catalog.histories.length) throw new Error('Invalid kernel pilot inventory');
  const maxRatio = catalog.exploration?.maxRatio;
  if (!catalog.exploration || Object.keys(catalog.exploration).join() !== 'maxRatio' || typeof maxRatio !== 'number'
    || !Number.isFinite(maxRatio) || maxRatio < 1) throw new Error('Invalid kernel pilot exploration bound');
  for (const [profile, model] of Object.entries(catalog.profiles)) {
    if (model.baseline !== `formal/dialcache-${profile}-conformance.qnt` || model.model !== `formal/kernel/${profile}-pilot.qnt`
      || model.module !== `${profile}_pilot`) throw new Error(`Invalid kernel pilot model: ${profile}`);
  }
  const ids = new Set();
  for (const history of catalog.histories) {
    if (typeof history.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(history.id) || ids.has(history.id)
      || !Object.hasOwn(catalog.profiles, history.profile)) throw new Error('Invalid or duplicate pilot history');
    ids.add(history.id);
    if (Object.keys(history).sort().join() !== 'actions,contracts,id,profile,witnesses'
      || !Array.isArray(history.contracts) || !history.contracts.length || history.contracts.some(id => !/^C\d{2}$/.test(id))
      || !Array.isArray(history.witnesses) || !history.witnesses.length || history.witnesses.some(label => typeof label !== 'string' || !label)) {
      throw new Error(`${history.id}: pilot histories contain inputs and evidence references only`);
    }
    if (!Array.isArray(history.actions) || history.actions.length < 2) throw new Error(`${history.id}: empty input schedule`);
    for (const [index, input] of history.actions.entries()) {
      if (!Array.isArray(input) || input.length !== 2 || !identifier(input[0]) || !Number.isSafeInteger(input[1]) || input[1] < -1
        || (index === 0 ? input[0] !== 'init' : input[0] === 'init')) throw new Error(`${history.id}: invalid input at step ${index}`);
    }
  }
  return catalog;
}

function qualifiedField(state, suffix, context) {
  const names = Object.keys(state).filter(name => name === suffix || name.endsWith(`::${suffix}`));
  if (names.length !== 1) throw new Error(`${context}: expected one declared ${suffix}, found ${names.length}`);
  return state[names[0]];
}

// A structural rename of explicit Quint exports, never a reconstruction from
// state differences. Public commands retain their existing profile encoding.
// The credited labels are the monitor's recorded label set at that state.
export function projectPilotTrace(raw, path = 'pilot') {
  if (!Array.isArray(raw?.states) || raw.states.length < 2) throw new Error(`${path}: missing pilot history`);
  return normalizeReplayInputs({ '#meta': structuredClone(raw['#meta'] ?? {}), vars: ['input', 's', 'pilotWitnesses'],
    states: raw.states.map((state, index) => {
      const context = `${path} step ${index}`;
      if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error(`${context}: missing pilot state`);
      const monitor = qualifiedField(state, 'K::monitor', context);
      if (!monitor || typeof monitor !== 'object' || Array.isArray(monitor) || !Array.isArray(monitor.labels?.['#set'])) {
        throw new Error(`${context}: witness monitor does not record a label set`);
      }
      return { input: structuredClone(qualifiedField(state, 'K::input', context)),
        s: structuredClone(qualifiedField(state, 'K::view', context)),
        pilotWitnesses: structuredClone(monitor.labels) };
    }) });
}

export function witnessCheckpoints(raw, required, path = 'pilot') {
  const checkpoints = Object.fromEntries(required.map(label => [label, []]));
  for (const [index, state] of raw.states.entries()) {
    const labels = state.pilotWitnesses?.['#set'];
    if (!Array.isArray(labels) || labels.some(label => typeof label !== 'string') || new Set(labels).size !== labels.length) {
      throw new Error(`${path} step ${index}: invalid Quint witness set`);
    }
    for (const label of required) if (labels.includes(label)) checkpoints[label].push(index);
  }
  for (const label of required) if (!checkpoints[label].length) throw new Error(`${path}: Quint never witnessed ${label}`);
  return checkpoints;
}

export function validatePilotChallenges(catalog, pilot) {
  if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.challenges) || !catalog.challenges.length) throw new Error('Missing kernel fault challenges');
  const ids = new Set();
  for (const challenge of catalog.challenges) {
    if (typeof challenge.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(challenge.id) || ids.has(challenge.id)
      || challenge.source !== 'formal/kernel/cache-kernel.qnt' || typeof challenge.before !== 'string' || !challenge.before
      || typeof challenge.after !== 'string' || challenge.before === challenge.after || !Array.isArray(challenge.checks) || !challenge.checks.length) {
      throw new Error('Invalid kernel fault challenge');
    }
    ids.add(challenge.id);
    for (const check of challenge.checks) {
      const history = pilot.histories.find(history => history.id === check.history);
      if (!history || history.profile !== check.profile || !pilotInvariants.includes(check.invariant)
        || !Number.isSafeInteger(check.failureStep) || check.failureStep < 0 || check.failureStep >= history.actions.length) {
        throw new Error(`${challenge.id}: invalid history, invariant or failure checkpoint`);
      }
    }
    if (read(resolve(root, challenge.source)).split(challenge.before).length !== 2) {
      throw new Error(`${challenge.id}: mutation anchor must match exactly once`);
    }
  }
  return catalog;
}

// A single invariant is checked at every state. Its first violation must occur
// at the declared input checkpoint; an evaluator error or earlier violation
// cannot substitute for detecting the specified semantic fault.
export function validatePilotChallengeResult(result, exitCode, raw, history, check, expectation) {
  validatePropertyResult(result, exitCode, expectation);
  const length = expectation === 'baseline' ? history.actions.length : check.failureStep + 1;
  if (!Array.isArray(raw?.states) || raw.states.length !== length || result.trace.length !== length) {
    throw new Error(`${history.profile}/${history.id}: ${expectation} did not reach the declared ${check.invariant} checkpoint ${length - 1}`);
  }
  for (const [index, state] of raw.states.entries()) {
    const input = qualifiedField(state, 'K::input', `${history.id} step ${index}`);
    if (!isDeepStrictEqual([input?.name, Number(input?.choice?.['#bigint'])], history.actions[index])) {
      throw new Error(`${history.id} step ${index}: ${expectation} executed a different challenge input`);
    }
  }
  return { status: expectation === 'baseline' ? 'passed' : 'detected', invariant: check.invariant, states: length, checkpoint: length - 1 };
}

export function validateWitnessControlResult(output, exitCode, required) {
  const passed = [...output.matchAll(/^\s*ok ([A-Za-z_]\w*) passed ([1-9]\d*) test\(s\)$/gm)].map(match => match[1]);
  if (exitCode !== 0 || !required.length || !isDeepStrictEqual([...passed].sort(), [...required].sort())) {
    throw new Error('Quint witness controls did not all complete successfully');
  }
  return { status: 'passed', tests: required };
}

// The original profile and the kernel view sample the same workload in the
// same job. Each side's wall time is the fastest of its repeated runs, which
// discounts a transient slowdown of one run on a shared runner, and includes
// CLI startup; the fixed cost of a one-sample, one-step run of each model is
// recorded so the evaluation-only ratio can be read as well. With maxRatio the
// comparison is the generation-runtime budget of issue #165: the record fails
// when the kernel's wall time exceeds maxRatio times the original's. Without
// maxRatio the comparison is informational. Every run must itself succeed.
export function explorationComparison(baseline, kernel, settings, bounds, { label = 'exploration', invariants, fixedCost, maxRatio } = {}) {
  const timings = {};
  for (const [name, measured] of Object.entries({ baseline, kernel })) {
    if (!Array.isArray(measured?.runs) || !measured.runs.length) throw new Error(`${label}: missing ${name} sampled exploration measurement`);
    for (const run of measured.runs) {
      validatePropertyResult(run.result, run.status, 'baseline');
      if (!Number.isFinite(run.durationMs) || run.durationMs <= 0) throw new Error(`${label}: invalid ${name} sampled exploration duration`);
    }
    const fixed = fixedCost?.[name];
    if (!Number.isFinite(fixed) || fixed <= 0) throw new Error(`${label}: missing ${name} fixed-cost measurement`);
    const durationMs = Math.min(...measured.runs.map(run => run.durationMs));
    if (durationMs <= fixed) throw new Error(`${label}: ${name} sampled for no longer than its fixed cost (${Math.round(durationMs)} ms against ${Math.round(fixed)} ms)`);
    timings[name] = { durationMs, durations: measured.runs.map(run => run.durationMs), reports: measured.runs.map(run => run.report),
      fixedCostMs: fixed, evaluationMs: durationMs - fixed };
  }
  if (!Array.isArray(invariants?.baseline) || !Array.isArray(invariants?.kernel)) throw new Error(`${label}: missing invariant lists`);
  if (maxRatio !== undefined && (typeof maxRatio !== 'number' || !Number.isFinite(maxRatio) || maxRatio < 1)) throw new Error(`${label}: invalid exploration bound`);
  const ratio = timings.kernel.durationMs / timings.baseline.durationMs;
  const evaluationRatio = timings.kernel.evaluationMs / timings.baseline.evaluationMs;
  const violation = maxRatio !== undefined && ratio > maxRatio
    ? `${label}: the kernel view took ${ratio.toFixed(2)}x the original profile's wall time (bound ${maxRatio}x); `
      + `${Math.round(timings.kernel.durationMs)} ms against ${Math.round(timings.baseline.durationMs)} ms`
    : undefined;
  return {
    status: violation ? 'failed' : 'passed', kind: 'sampled-exploration', backend: settings.backend,
    seed: settings.seed, threads: 1, bounds: { maxSamples: bounds.maxSamples, maxSteps: bounds.maxSteps },
    invariants: { baseline: [...invariants.baseline], kernel: [...invariants.kernel] }, includesCliStartup: true, sameInputHistories: false,
    baseline: timings.baseline, kernel: timings.kernel, ratio, evaluationRatio,
    ...(maxRatio === undefined ? { gated: false } : { gated: true, maxRatio }), ...(violation ? { violation } : {})
  };
}

function publicHistory(profile, raw, path) {
  const trace = profile === 'effects' ? parseEffects(raw, path) : parseFeatures(raw, path, profiles.layers);
  const observations = profile === 'effects' ? expectedObservations(trace) : trace.steps.map(step => step.expected);
  return trace.steps.map((step, index) => ({ action: step.action, choice: step.choice ?? -1, observed: observations[index] }));
}

export function comparePilotHistory(profile, baseline, pilot, actions, path = 'pilot') {
  const expected = publicHistory(profile, baseline, `${path} baseline`);
  const actual = publicHistory(profile, pilot, `${path} kernel`);
  if (expected.length !== actions.length || actual.length !== actions.length) throw new Error(`${path}: incomplete schedule (${expected.length}/${actual.length}, expected ${actions.length})`);
  for (let index = 0; index < actions.length; index++) {
    const input = actions[index];
    for (const [name, history] of [['baseline', expected], ['kernel', actual]]) {
      if (!isDeepStrictEqual([history[index].action, history[index].choice], input)) throw new Error(`${path} step ${index}: ${name} executed a different input`);
    }
    if (!isDeepStrictEqual(expected[index].observed, actual[index].observed)) {
      throw new Error(`${path} step ${index} action ${input[0]} choice ${input[1]}\nexpected baseline: ${JSON.stringify(expected[index].observed)}\nactual kernel: ${JSON.stringify(actual[index].observed)}`);
    }
  }
  return { steps: actions.length, status: 'passed' };
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : entry.isFile() ? [path] : [];
  });
}
function sources() {
  const paths = [...defaultSources('typescript'), ...defaultSources('go').filter(path => !path.startsWith('.formal-traces/')),
    ...filesBelow(resolve(root, 'formal')).filter(path => /\.(qnt|mjs|mts|json)$/.test(path)).map(path => relative(root, path))];
  return Object.fromEntries([...new Set(paths)].sort().map(path => [path, digest(readFileSync(resolve(root, path)))]));
}

async function execute(command, args, directory, logPath, env = cleanEnvironment(process.env), allowedStatuses = [0]) {
  const result = await spawnBuffered(command, args, { cwd: directory, env, timeoutMs: 300_000 });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, result.stdout + result.stderr);
  if (result.error || !allowedStatuses.includes(result.status)) throw new Error(`${command} failed (${result.error ?? result.signal ?? result.status}); inspect ${logPath}\n${(result.stdout + result.stderr).slice(-5000)}`);
  return result;
}

async function prepareModel(model, moduleName, directory) {
  const copied = resolve(directory, 'formal');
  for (const path of filesBelow(resolve(root, 'formal')).filter(path => path.endsWith('.qnt'))) {
    const target = resolve(copied, relative(resolve(root, 'formal'), path));
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(path, target);
  }
  const sourcePath = resolve(directory, model), source = read(sourcePath);
  const parsedPath = resolve(directory, 'parsed.json'), mapPath = resolve(directory, 'source-map.json');
  await execute('quint', ['parse', sourcePath, `--out=${parsedPath}`, `--source-map=${mapPath}`], root, resolve(directory, 'parse.log'));
  const parsed = json(parsedPath);
  if (parsed.errors.length) throw new Error(`${model}: Quint parse errors`);
  const name = moduleName ?? /^module\s+(\w+)\s*\{/.exec(source)?.[1];
  const declarations = parsed.modules.find(module => module.name === name)?.declarations;
  if (!declarations) throw new Error(`${model}: missing parsed module ${name}`);
  return { path: sourcePath, source, parsed, declarations: new Map(declarations.map(d => [d.name, d])), sourceMap: json(mapPath) };
}

async function generateHistory(model, history, output, settings, invariant) {
  const additions = [], clones = new Map();
  const calls = history.actions.map(([action, choice]) => {
    const key = `${action}/${choice}`;
    if (!clones.has(key)) {
      const name = `pilotAction${clones.size}`;
      additions.push(`action ${name} = ${constrainAction(model.source, model.declarations.get(action), model.sourceMap, choice)}`);
      clones.set(key, name);
    }
    return clones.get(key);
  });
  additions.push('var pilotCursor: int');
  additions.push(`action pilotInit = all { ${calls[0]}, pilotCursor' = 0 }`);
  additions.push(`action pilotStep = any { ${calls.slice(1).map((call, index) => `all { pilotCursor == ${index}, ${call}, pilotCursor' = ${index + 1} }`).join(', ')} }`);
  const end = model.source.lastIndexOf('}');
  writeFileSync(model.path, model.source.slice(0, end) + '\n' + additions.join('\n') + '\n' + model.source.slice(end));
  const result = await execute('quint', ['run', model.path, `--backend=${settings.backend}`, '--n-threads=1', '--max-samples=1', `--seed=${settings.seed}`,
    '--init=pilotInit', '--step=pilotStep', `--max-steps=${calls.length - 1}`, '--n-traces=1', `--out-itf=${output}`,
    ...(invariant ? ['--invariants', invariant, `--out=${output}.result.json`] : [])], root, `${output}.log`, cleanEnvironment(process.env), invariant ? [0, 1] : [0]);
  return { raw: json(output), durationMs: result.durationMs, status: result.status,
    ...(invariant ? { result: json(`${output}.result.json`) } : {}) };
}

async function checkModel(profile, definition, model, settings, bounds, output) {
  const directory = resolve(output, 'checks', profile); mkdirSync(directory, { recursive: true });
  const index = indexModules(model.parsed, { main: definition.module });
  const lint = { thinProfile: lintThinProfile(index, { kernelModules: ['cache_kernel'] }),
    witnessIsolation: lintWitnessIsolation(index, { witnessPattern: '(^|::)monitor$', observationField: 'view' }) };
  save(resolve(directory, 'lint.json'), lint);
  if (lint.thinProfile.count || lint.witnessIsolation.count || lint.witnessIsolation.witnessVariables.length !== 1) {
    throw new Error(`${profile}: kernel ownership or witness isolation lint failed; inspect ${resolve(directory, 'lint.json')}`);
  }
  await execute('quint', ['typecheck', model.path], root, resolve(directory, 'typecheck.log'));
  const path = resolve(directory, 'bounded.json');
  const run = await execute('quint', ['run', model.path, `--backend=${settings.backend}`, '--n-threads=1', `--seed=${settings.seed}`,
    `--max-samples=${bounds.maxSamples}`, `--max-steps=${bounds.maxSteps}`, '--invariants', ...pilotInvariants, `--out=${path}`], root, `${path}.log`);
  validatePropertyResult(json(path), run.status, 'baseline');
  return { status: 'passed', bounds: { maxSamples: bounds.maxSamples, maxSteps: bounds.maxSteps }, invariants: pilotInvariants,
    invariantScope: {
      publicationHasTimelySource: `Retained serialization-acceptance records and counts, recorded-fence checks and ownership; ${profile === 'effects'
        ? 'source deadline acceptance is exercised.' : 'source deadlines are disabled in this view.'}`,
      closedScopesHaveNoMemo: profile === 'layers' ? 'Closed request scopes cannot retain memo entries.'
        : 'Request memoization is disabled in this view; the property is not consequential.'
    },
    durationMs: run.durationMs, lint: { thinProfile: 0, witnessIsolation: 0 }, report: relative(root, path) };
}

// Two pairings of the original profile's generation workload (its sample
// count and step bound from execution.json, without trace output), each run
// twice per model. With each model's own invariants is what the generation
// lane pays and is the gated pairing. Without invariants isolates transition
// and monitor cost from property cost and is recorded, not gated. A
// one-sample, one-step run of each model measures the fixed CLI cost. Equal
// seeds do not imply equal inputs across different choice trees.
export const explorationRepetitions = 2;
async function measureExploration(profile, baseline, kernel, settings, generation, output, { baselineInvariants, maxRatio, persist }) {
  const bounds = { maxSamples: generation.maxSamples, maxSteps: generation.maxSteps };
  const options = [`--backend=${settings.backend}`, '--n-threads=1', `--seed=${settings.seed}`];
  const sample = async (name, model, invariants, samples, steps) => {
    const runs = [];
    for (let repetition = 1; repetition <= explorationRepetitions; repetition++) {
      const path = resolve(output, 'checks', profile, `exploration-${name}-${repetition}.json`);
      const run = await execute('quint', ['run', model.path, ...options, `--max-samples=${samples}`, `--max-steps=${steps}`,
        ...(invariants.length ? ['--invariants', ...invariants] : []), `--out=${path}`], root, `${path}.log`);
      runs.push({ result: json(path), status: run.status, durationMs: run.durationMs, report: relative(root, path) });
    }
    return { runs };
  };
  const fixedCost = {};
  for (const [name, model] of Object.entries({ baseline, kernel })) {
    const measured = await sample(`fixed-${name}`, model, [], 1, 1);
    for (const run of measured.runs) validatePropertyResult(run.result, run.status, 'baseline');
    fixedCost[name] = Math.min(...measured.runs.map(run => run.durationMs));
  }
  const report = { repetitions: explorationRepetitions, fixedCost };
  report.withInvariants = explorationComparison(
    await sample('baseline-invariants', baseline, baselineInvariants, bounds.maxSamples, bounds.maxSteps),
    await sample('kernel-invariants', kernel, pilotInvariants, bounds.maxSamples, bounds.maxSteps), settings, bounds,
    { label: `${profile} exploration with invariants`, invariants: { baseline: baselineInvariants, kernel: pilotInvariants }, fixedCost, maxRatio });
  persist(report);
  if (report.withInvariants.violation) throw new Error(report.withInvariants.violation);
  report.withoutInvariants = explorationComparison(
    await sample('baseline', baseline, [], bounds.maxSamples, bounds.maxSteps),
    await sample('kernel', kernel, [], bounds.maxSamples, bounds.maxSteps), settings, bounds,
    { label: `${profile} exploration without invariants`, invariants: { baseline: [], kernel: [] }, fixedCost });
  persist(report);
  return report;
}

async function checkWitnessControls(settings, output) {
  const directory = resolve(output, 'checks', 'witness-controls');
  const model = await prepareModel('formal/kernel/lifecycle-witnesses-test.qnt', 'lifecycle_witnesses_test', directory);
  const tests = [...model.declarations.values()].filter(declaration => declaration.qualifier === 'run').map(declaration => declaration.name);
  await execute('quint', ['typecheck', model.path], root, resolve(directory, 'typecheck.log'));
  const path = resolve(directory, 'tests.log');
  const result = await execute('quint', ['test', model.path, `--backend=${settings.backend}`, '--max-samples=1', `--seed=${settings.seed}`,
    `--match=^(${tests.join('|')})$`], root, path);
  return { ...validateWitnessControlResult(result.stdout + result.stderr, result.status, tests), durationMs: result.durationMs, report: relative(root, path) };
}

async function checkChallenges(catalog, pilot, settings, output, report, persist) {
  for (const challenge of catalog.challenges) {
    const source = read(resolve(root, challenge.source));
    for (const check of challenge.checks) {
      const history = pilot.histories.find(history => history.id === check.history);
      const entry = { id: challenge.id, ...check, status: 'running' };
      report.challenges.push(entry); persist();
      const directory = resolve(output, 'challenges', challenge.id, check.profile, check.history);
      const definition = pilot.profiles[check.profile];
      const model = await prepareModel(definition.model, definition.module, directory);
      const mutationPath = resolve(directory, challenge.source);
      for (const expectation of ['baseline', 'mutant']) {
        writeFileSync(mutationPath, expectation === 'baseline' ? source : source.replace(challenge.before, challenge.after));
        // Compile before running either property measurement. Scheduler code is
        // regenerated from the same unmodified profile for both measurements.
        writeFileSync(model.path, model.source);
        await execute('quint', ['typecheck', model.path], root, resolve(directory, `${expectation}-typecheck.log`));
        const path = resolve(directory, `${expectation}.itf.json`);
        const measured = await generateHistory(model, history, path, settings, check.invariant);
        entry[expectation] = validatePilotChallengeResult(measured.result, measured.status, measured.raw, history, check, expectation);
        entry[expectation].report = relative(root, `${path}.result.json`);
        entry[expectation].trace = relative(root, path);
        persist();
      }
      entry.status = 'passed'; persist();
    }
  }
}

async function replayNative(history, path, directory) {
  const environment = { ...cleanEnvironment(process.env), [history.profile === 'effects' ? 'DIALCACHE_EFFECTS_TRACE_FILE' : 'DIALCACHE_FEATURE_TRACE_FILE']: path };
  if (history.profile === 'layers') environment.DIALCACHE_FEATURE_PROFILE = 'layers';
  const entry = { id: `kernel-pilot/${history.id}`, category: 'regression', profile: history.profile, path: relative(root, path) };
  const tsPath = resolve(directory, `${history.id}.typescript.json`);
  await execute('corepack', ['pnpm', 'exec', 'vitest', 'run', `test/formal-${history.profile === 'effects' ? 'effects' : 'features'}.test.ts`,
    '--coverage.enabled=false', '--reporter=json', `--outputFile=${tsPath}`], root, `${tsPath}.log`, environment);
  const typescript = parseTypeScriptReport(read(tsPath), [entry], root);
  const goPath = resolve(directory, `${history.id}.go.jsonl`);
  const go = await execute('go', ['-C', 'go', 'test', '-race', '-count=1', '-json', '-timeout=4m', '-run',
    history.profile === 'effects' ? '^TestEffectsConformance$' : '^TestFeatureConformance$', '.'], root, `${goPath}.log`, environment);
  writeFileSync(goPath, go.stdout);
  const packageName = /^module\s+(\S+)\s*$/m.exec(read(resolve(root, 'go/go.mod')))?.[1];
  const result = checkGoReplay(go.stdout, { packageName, profiles: { [history.profile]: 0 }, witnessProfiles: [],
    required: [{ name: nativeBinding(entry, 'go'), category: 'pilot' }] });
  return { typescript: { status: 'passed', assertions: typescript.results.length, report: relative(root, tsPath), sha256: digest(read(tsPath)) },
    go: { status: 'passed', assertions: result.passedLeaves, report: relative(root, goPath), sha256: digest(go.stdout) } };
}

export async function runPilot(mode = 'check') {
  if (!['generate', 'check'].includes(mode)) throw new Error('Usage: node formal/kernel-pilot.mjs [generate|check]');
  const output = resolve(root, outputPath), reportPath = resolve(output, 'report.json');
  rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
  const report = { schemaVersion: 1, kind: 'kernel-pilot', acceptance: false, status: 'running', complete: false,
    mode, startedAt: new Date().toISOString(), histories: [] };
  save(reportPath, report);
  try {
    const catalog = validatePilot(json(resolve(root, catalogPath)));
    const challenges = mode === 'check' ? validatePilotChallenges(json(resolve(root, challengePath)), catalog) : undefined;
    const execution = json(resolve(root, 'formal/execution.json')), settings = execution.settings;
    report.sources = sources(); report.seed = settings.seed;
    report.models = {}; report.challenges = []; report.exploration = {};
    if (mode === 'check') report.witnessControls = await checkWitnessControls(settings, output);
    const models = new Map();
    for (const [profile, definition] of Object.entries(catalog.profiles)) {
      for (const flavor of ['baseline', 'pilot']) {
        const directory = resolve(output, 'build', profile, flavor);
        const model = flavor === 'baseline' ? definition.baseline : definition.model;
        const prepared = await prepareModel(model, flavor === 'pilot' ? definition.module : undefined, directory);
        models.set(`${profile}/${flavor}`, prepared);
        if (mode === 'check' && flavor === 'pilot') report.models[profile] = await checkModel(profile, definition, prepared, settings, execution.check, output);
      }
      if (mode === 'check') {
        const original = execution.models.find(model => model.path === definition.baseline);
        if (!Array.isArray(original?.invariants) || !original.invariants.length) throw new Error(`${profile}: the original profile declares no invariants in execution.json`);
        if (!Number.isSafeInteger(original.generate?.maxSamples) || !Number.isSafeInteger(original.generate?.maxSteps)) throw new Error(`${profile}: the original profile declares no generation bounds in execution.json`);
        await measureExploration(profile, models.get(`${profile}/baseline`), models.get(`${profile}/pilot`), settings, original.generate, output,
          { baselineInvariants: original.invariants, maxRatio: catalog.exploration.maxRatio,
            persist: measured => { report.exploration[profile] = measured; save(reportPath, report); } });
      }
    }
    for (const history of catalog.histories) {
      console.log(`Kernel pilot ${history.profile}/${history.id}`);
      const result = { id: history.id, profile: history.profile, contracts: history.contracts, status: 'running' };
      report.histories.push(result); save(reportPath, report);
      const directory = resolve(output, 'traces', history.profile); mkdirSync(directory, { recursive: true });
      const baselinePath = resolve(directory, `${history.id}.baseline.json`), rawPath = resolve(directory, `${history.id}.kernel.json`);
      const baselineRun = await generateHistory(models.get(`${history.profile}/baseline`), history, baselinePath, settings);
      const pilotRun = await generateHistory(models.get(`${history.profile}/pilot`), history, rawPath, settings);
      const baseline = normalizeReplayInputs(baselineRun.raw), pilot = projectPilotTrace(pilotRun.raw, rawPath);
      const traceBytes = { baseline: statSync(baselinePath).size, kernel: statSync(rawPath).size };
      result.generation = { baselineMs: baselineRun.durationMs, kernelMs: pilotRun.durationMs, ratio: pilotRun.durationMs / baselineRun.durationMs,
        traceBytes: { ...traceBytes, ratio: traceBytes.kernel / traceBytes.baseline } };
      result.differential = comparePilotHistory(history.profile, baseline, pilot, history.actions, `${history.profile}/${history.id}`);
      result.witnesses = witnessCheckpoints(pilot, history.witnesses, `${history.profile}/${history.id}`);
      const path = resolve(directory, `${history.id}.itf.json`); save(path, pilot);
      bindTrace(history.profile, pilot, path);
      result.trace = { path: relative(root, path), sha256: digest(read(path)), raw: relative(root, rawPath), rawSha256: digest(read(rawPath)),
        baseline: relative(root, baselinePath), baselineSha256: digest(read(baselinePath)) };
      if (mode === 'check') result.native = await replayNative(history, path, resolve(output, 'native'));
      result.status = 'passed'; save(reportPath, report);
    }
    if (mode === 'check') await checkChallenges(challenges, catalog, settings, output, report, () => save(reportPath, report));
    const after = sources();
    const changed = [...new Set([...Object.keys(after), ...Object.keys(report.sources)])].filter(path => after[path] !== report.sources[path]);
    if (changed.length) throw new Error(`Kernel pilot inputs changed during validation: ${changed.join(', ')}`);
    report.sourcesUnchanged = true;
    report.status = mode === 'check' ? 'passed' : 'generated';
    report.complete = mode === 'check';
  } catch (error) {
    report.status = 'failed'; report.error = String(error); throw error;
  } finally {
    report.finishedAt = new Date().toISOString(); save(reportPath, report);
    console.log(`Kernel pilot evidence: ${reportPath}`);
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node formal/kernel-pilot.mjs [generate|check]');
  await runPilot(process.argv[2]);
}
