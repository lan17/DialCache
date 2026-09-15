import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
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
import { readExecution, validateExecution } from './execution.mjs';
import { generationArguments } from './run-models.mjs';
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
  for (const key of ['exploration', 'generation']) {
    const bound = catalog[key]?.maxRatio;
    if (!catalog[key] || Object.keys(catalog[key]).join() !== 'maxRatio' || typeof bound !== 'number' || !Number.isFinite(bound) || bound < 1) {
      throw new Error(`Invalid kernel pilot ${key} bound`);
    }
  }
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
  for (const label of required) {
    if (!checkpoints[label].length) throw new Error(`${path}: Quint never witnessed ${label}`);
    // Labels accumulate, so a credited label is still recorded at the last state.
    if (!checkpoints[label].includes(raw.states.length - 1)) throw new Error(`${path}: Quint did not retain ${label} at the final state`);
  }
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
// recorded so the evaluation-only ratio can be read as well. Each side
// carries the invariants its runs were sampled with. With maxRatio the record
// fails when the kernel's wall time exceeds maxRatio times the original's;
// without maxRatio the comparison is informational. Every run must itself
// succeed. This bounds sampling cost, not the generation lane's trace output;
// measureGeneration records that.
export function explorationComparison(baseline, kernel, settings, bounds, fixedCost, { label, maxRatio }) {
  const timings = {};
  for (const [name, measured] of Object.entries({ baseline, kernel })) {
    if (!Array.isArray(measured?.runs) || !measured.runs.length) throw new Error(`${label}: missing ${name} sampled exploration measurement`);
    if (!Array.isArray(measured.invariants)) throw new Error(`${label}: missing ${name} invariant list`);
    for (const run of measured.runs) {
      validatePropertyResult(run.result, run.status, 'baseline');
      if (!Number.isFinite(run.durationMs) || run.durationMs <= 0) throw new Error(`${label}: invalid ${name} sampled exploration duration`);
    }
    const fixed = fixedCost?.[name];
    if (!Number.isFinite(fixed) || fixed <= 0) throw new Error(`${label}: missing ${name} fixed-cost measurement`);
    const durationMs = Math.min(...measured.runs.map(run => run.durationMs));
    if (durationMs <= fixed) throw new Error(`${label}: ${name} sampled for no longer than its fixed cost (${Math.round(durationMs)} ms against ${Math.round(fixed)} ms)`);
    timings[name] = { invariants: [...measured.invariants], durationMs, durations: measured.runs.map(run => run.durationMs),
      reports: measured.runs.map(run => run.report), fixedCostMs: fixed, evaluationMs: durationMs - fixed };
  }
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
    includesCliStartup: true, sameInputHistories: false, tracesWritten: false,
    baseline: timings.baseline, kernel: timings.kernel, ratio, evaluationRatio,
    ...(maxRatio === undefined ? { gated: false } : { gated: true, maxRatio }), ...(violation ? { violation } : {})
  };
}

// The generation lane's own command for the original profile (from
// run-models.mjs), issued for both models: --mbt, the original's trace count,
// ITF output. Traces go to a scratch directory that is removed after counting,
// so the evidence artifact does not grow by hundreds of megabytes. The
// outcome classifies how a run ended: completed; violation when Quint reports
// a violated property (Quint exits 1 for every failure, so only its own marker
// says which); aborted when a signal or a timeout ended the process; failed
// otherwise. A timeout is recorded with its bound. This measurement is
// recorded, not gated, until the kernel's exported state fits the lane; a
// property violation on either side and an original that cannot complete its
// own command are raised by the caller after the correctness evidence.
export function generationOutcome(name, result, traces, generation, bytes, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`${name}: a generation attempt records the timeout it ran under`);
  const output = result.stdout + result.stderr;
  const completed = !result.error && result.status === 0 && traces === generation.traces;
  const violated = /^error: Invariant violated$/m.test(output) || /^\[violation\]/m.test(output);
  const status = completed ? 'completed' : violated ? 'violation' : result.error || result.signal ? 'aborted' : 'failed';
  const diagnostics = [...(result.error ? [result.error.message] : []),
    ...output.split('\n').map(line => line.trim()).filter(line => /out of memory|heap|fatal|error|killed|QNT\d{3}/i.test(line)).slice(0, 3)];
  return { status, exitStatus: result.status ?? null, signal: result.signal ?? null, durationMs: result.durationMs,
    traces, expectedTraces: generation.traces, traceBytes: bytes, timeoutMs, timedOut: result.error?.code === 'ETIMEDOUT',
    ...(completed ? {} : { diagnostics: diagnostics.length ? diagnostics : [`${name} wrote ${traces} of ${generation.traces} traces`] }) };
}

// Parity is the kernel view completing the lane's command under the lane's
// own Node heap within maxRatio times the original in both wall time and
// trace bytes. Exported-state size is part of parity on purpose: the traces
// are what the replay lanes read and what exhausts the heap. Peak memory is
// not measured; completion under the default heap stands in for it.
export function generationParity(baseline, kernel, maxRatio) {
  const both = baseline.status === 'completed' && kernel.status === 'completed';
  const ratio = both ? kernel.durationMs / baseline.durationMs : null;
  const traceBytesRatio = both ? kernel.traceBytes / baseline.traceBytes : null;
  return { ratio, traceBytesRatio, maxRatio, parity: both && ratio <= maxRatio && traceBytesRatio <= maxRatio };
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
  // The scheduler compiles as a sibling of the prepared copy, so its relative
  // imports resolve and the copy itself is never rewritten; Quint selects the
  // main module by content, not by file name. The sibling holds the schedule
  // of the last history it ran, which is the failing one when a check stops.
  const scheduledPath = `${model.path.slice(0, -'.qnt'.length)}.scheduled.qnt`;
  writeFileSync(scheduledPath, model.source.slice(0, end) + '\n' + additions.join('\n') + '\n' + model.source.slice(end));
  const result = await execute('quint', ['run', scheduledPath, `--backend=${settings.backend}`, '--n-threads=1', '--max-samples=1', `--seed=${settings.seed}`,
    '--init=pilotInit', '--step=pilotStep', `--max-steps=${calls.length - 1}`, '--n-traces=1', `--out-itf=${output}`,
    ...(invariant ? ['--invariants', invariant, `--out=${output}.result.json`] : [])], root, `${output}.log`, cleanEnvironment(process.env), invariant ? [0, 1] : [0]);
  return { raw: json(output), durationMs: result.durationMs, status: result.status, scheduled: relative(root, scheduledPath),
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

// Sampling pairings at the original profile's generation bounds (its sample
// count and step bound from execution.json), without trace output, two
// repetitions per sample with its sides alternating so a sustained slowdown
// lands on every side. With each model's own invariants is the gated pairing:
// it bounds the kernel's sampling cost; the kernel view with its witness
// monitor frozen runs as a third side of that sample so its record shares the
// window. Both models without invariants form a second, ungated sample. A
// one-sample, one-step run of each model measures the fixed CLI cost. Equal
// seeds do not imply equal inputs across different choice trees. A violation
// is recorded here and raised by the caller after the correctness evidence.
export const explorationRepetitions = 2;
// The kernel's single monitor assignment; replacing it freezes witness
// bookkeeping without touching a transition, so the difference to the full
// view is the monitor's cost.
export const monitorAssignment = {
  before: "monitor' = Witness::advance(monitor, { input: command, observation: publicView(updated) },\n      not(SETTLE.read), updated.config.sourceBudget)",
  after: "monitor' = monitor"
};
export function validateMonitorAnchor(source, context = 'formal/kernel/cache-kernel.qnt') {
  if (source.split(monitorAssignment.before).length !== 2) throw new Error(`${context}: the kernel's monitor assignment anchor must match exactly once`);
  return source;
}
async function measureExploration(profile, models, settings, generation, output, { baselineInvariants, maxRatio }) {
  const { baseline, kernel, frozen } = models;
  const bounds = { maxSamples: generation.maxSamples, maxSteps: generation.maxSteps };
  const options = [`--backend=${settings.backend}`, '--n-threads=1', `--seed=${settings.seed}`];
  // A property violation in a sampling run exits 1 with a counterexample in
  // the --out report; it must surface as one, naming the run that found it.
  const run = async (name, model, invariants, samples, steps, repetition) => {
    const path = resolve(output, 'checks', profile, `exploration-${name}-${repetition}.json`);
    const measured = await execute('quint', ['run', model.path, ...options, `--max-samples=${samples}`, `--max-steps=${steps}`,
      ...(invariants.length ? ['--invariants', ...invariants] : []), `--out=${path}`], root, `${path}.log`, cleanEnvironment(process.env), [0, 1]);
    const result = json(path);
    try {
      validatePropertyResult(result, measured.status, 'baseline');
    } catch (error) {
      throw new Error(`${name} run ${repetition}: ${error.message}; see ${relative(root, path)}`);
    }
    return { result, status: measured.status, durationMs: measured.durationMs, report: relative(root, path) };
  };
  // sides: [name, model, invariants]; every side runs once per repetition, in order.
  const sample = async (sides, samples, steps) => {
    const runs = Object.fromEntries(sides.map(([name]) => [name, []]));
    for (let repetition = 1; repetition <= explorationRepetitions; repetition++) {
      for (const [name, model, invariants] of sides) runs[name].push(await run(name, model, invariants, samples, steps, repetition));
    }
    return Object.fromEntries(sides.map(([name, , invariants]) => [name, { runs: runs[name], invariants }]));
  };
  const fixed = await sample([['fixed-baseline', baseline, []], ['fixed-kernel', kernel, []]], 1, 1);
  const fixedCost = { baseline: Math.min(...fixed['fixed-baseline'].runs.map(measured => measured.durationMs)),
    kernel: Math.min(...fixed['fixed-kernel'].runs.map(measured => measured.durationMs)) };
  const report = { repetitions: explorationRepetitions, interleaved: true, fixedCost };
  const gated = await sample([['baseline-invariants', baseline, baselineInvariants], ['kernel-invariants', kernel, pilotInvariants],
    ['kernel-frozen-monitor', frozen, pilotInvariants]], bounds.maxSamples, bounds.maxSteps);
  report.withInvariants = explorationComparison(gated['baseline-invariants'], gated['kernel-invariants'], settings, bounds, fixedCost,
    { label: `${profile} exploration with invariants`, maxRatio });
  const plain = await sample([['baseline', baseline, []], ['kernel', kernel, []]], bounds.maxSamples, bounds.maxSteps);
  report.withoutInvariants = explorationComparison(plain.baseline, plain.kernel, settings, bounds, fixedCost,
    { label: `${profile} exploration without invariants` });
  // The kernel view with its monitor frozen, against the original with its own
  // invariants, from the same interleaved sample as the gated pairing: the
  // difference to the gated kernel run is the cost of the kernel's witness
  // observation (publicView) and the monitor's advance. The unfrozen view's
  // fixed cost serves the frozen one; freezing changes no CLI startup.
  const frozenComparison = explorationComparison(gated['baseline-invariants'], gated['kernel-frozen-monitor'], settings, bounds, fixedCost,
    { label: `${profile} exploration with frozen monitor` });
  report.monitorFrozen = { ...frozenComparison, monitorMs: report.withInvariants.kernel.durationMs - frozenComparison.kernel.durationMs };
  // Each side's property cost is its gated run less its plain run; the gated
  // ratio flatters a kernel that carries fewer, cheaper properties than the
  // original, so both costs are recorded next to it.
  const propertyCost = Object.fromEntries(['baseline', 'kernel'].map(name =>
    [name, report.withInvariants[name].durationMs - report.withoutInvariants[name].durationMs]));
  report.propertyCost = { ...propertyCost, ratio: propertyCost.kernel / propertyCost.baseline };
  return report;
}

// These are the pilot's own bounds; the generation lane has no per-command
// ceiling, only its job timeout. The original's attempt gets a fixed ceiling
// far above its observed 27 to 32 s hosted. The kernel view may take at most
// the bound times the original, so a run well past that cannot reach parity;
// its timeout is four times the original's wall time, at least 150 s so the
// observed heap-exhaustion abort (78 to 84 s hosted) stays observable instead
// of being cut off by the timer, and at most the original's ceiling. A timeout
// ends the quint process; its Rust evaluator exits with it (verified: none
// survived a SIGTERM mid-sampling).
export const generationTimeout = { originalMs: 600_000, kernelFactor: 4, kernelFloorMs: 150_000 };
export function kernelGenerationTimeout(original) {
  return Math.min(Math.max(Math.round(generationTimeout.kernelFactor * original.durationMs), generationTimeout.kernelFloorMs), generationTimeout.originalMs);
}
// What "completes under the default heap" means depends on the node that the
// quint shim resolves on PATH and on NODE_OPTIONS, which the attempts inherit;
// neither is necessarily the pilot's own process (direct invocation, per-process
// node flags), so the probe is a child of the same environment.
export function parseNodeEnvironment(result) {
  if (result.error || result.status !== 0) throw new Error(`Cannot probe the node that runs quint: ${result.error?.message ?? result.stderr.trim()}`);
  const probed = JSON.parse(result.stdout);
  for (const field of ['version', 'execPath']) if (typeof probed[field] !== 'string' || !probed[field]) throw new Error(`Node probe returned no ${field}`);
  for (const field of ['heapSizeLimit', 'totalMemory']) if (!Number.isSafeInteger(probed[field]) || probed[field] <= 0) throw new Error(`Node probe returned no ${field}`);
  return { version: probed.version, execPath: probed.execPath, heapSizeLimit: probed.heapSizeLimit, totalMemory: probed.totalMemory };
}
export const nodeProbe = ['-p', 'JSON.stringify({ version: process.version, execPath: process.execPath, '
  + 'heapSizeLimit: require("v8").getHeapStatistics().heap_size_limit, totalMemory: require("os").totalmem() })'];
async function measureGeneration(profile, baseline, kernel, settings, generation, baselineInvariants, maxRatio, output) {
  const environment = cleanEnvironment(process.env);
  const node = parseNodeEnvironment(await spawnBuffered('node', nodeProbe, { cwd: root, env: environment, timeoutMs: 30_000 }));
  const attempt = async (name, model, invariants, timeoutMs) => {
    const directory = resolve(output, 'checks', profile, `generation-${name}`); mkdirSync(directory, { recursive: true });
    const logPath = resolve(output, 'checks', profile, `generation-${name}.log`);
    try {
      const result = await spawnBuffered('quint', generationArguments(model.path, generation, invariants, { settings, seed: settings.seed, outputDirectory: directory }),
        { cwd: root, env: environment, timeoutMs });
      writeFileSync(logPath, result.stdout + result.stderr);
      const traces = readdirSync(directory).filter(file => file.endsWith('.itf.json'));
      const bytes = traces.reduce((sum, file) => sum + statSync(resolve(directory, file)).size, 0);
      return { ...generationOutcome(name, result, traces.length, generation, bytes, timeoutMs), invariants: [...invariants], log: relative(root, logPath) };
    } finally {
      // The traces are the lane's full corpus; the evidence artifact keeps only the counts.
      rmSync(directory, { recursive: true, force: true });
    }
  };
  const original = await attempt('baseline', baseline, baselineInvariants, generationTimeout.originalMs);
  const view = original.status === 'completed'
    ? await attempt('kernel', kernel, pilotInvariants, kernelGenerationTimeout(original))
    : { status: 'not-attempted', reason: 'the original profile did not complete its own generation command', invariants: [...pilotInvariants] };
  const record = { kind: 'generation-workload', gated: false, tracesWritten: true, mbt: true,
    bounds: { maxSamples: generation.maxSamples, maxSteps: generation.maxSteps, traces: generation.traces },
    environment: { nodeOptions: environment.NODE_OPTIONS ?? null, node },
    baseline: original, kernel: view, ...generationParity(original, view, maxRatio) };
  const problems = [];
  if (original.status !== 'completed') {
    problems.push(`${profile} generation: the original profile did not complete its own generation command `
      + `(exit ${original.exitStatus}, signal ${original.signal}; ${original.diagnostics[0]}; see ${original.log})`);
  }
  for (const [name, outcome] of [['original profile', original], ['kernel view', view]]) {
    if (outcome.status === 'violation') problems.push(`${profile} generation: the ${name} violated a property while generating; see ${outcome.log}`);
  }
  return { record, problems };
}

// A copy of the kernel view whose monitor never advances, for cost attribution.
async function prepareFrozenModel(definition, directory) {
  const model = await prepareModel(definition.model, definition.module, directory);
  const kernelPath = resolve(directory, 'formal/kernel/cache-kernel.qnt');
  writeFileSync(kernelPath, validateMonitorAnchor(read(kernelPath), definition.model).replace(monitorAssignment.before, monitorAssignment.after));
  await execute('quint', ['typecheck', model.path], root, resolve(directory, 'typecheck.log'));
  return model;
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
  const report = { schemaVersion: 2, kind: 'kernel-pilot', acceptance: false, status: 'running', complete: false,
    mode, startedAt: new Date().toISOString(), histories: [] };
  save(reportPath, report);
  try {
    const catalog = validatePilot(json(resolve(root, catalogPath)));
    const challenges = mode === 'check' ? validatePilotChallenges(json(resolve(root, challengePath)), catalog) : undefined;
    if (mode === 'check') validateMonitorAnchor(read(resolve(root, 'formal/kernel/cache-kernel.qnt')));
    const execution = readExecution(), settings = execution.settings;
    validateExecution(execution);
    report.sources = sources(); report.seed = settings.seed;
    report.models = {}; report.challenges = []; report.exploration = {}; report.generation = {};
    if (mode === 'check') report.witnessControls = await checkWitnessControls(settings, output);
    const models = new Map(), originals = new Map();
    const violations = [];
    for (const [profile, definition] of Object.entries(catalog.profiles)) {
      for (const flavor of ['baseline', 'pilot']) {
        const directory = resolve(output, 'build', profile, flavor);
        const model = flavor === 'baseline' ? definition.baseline : definition.model;
        const prepared = await prepareModel(model, flavor === 'pilot' ? definition.module : undefined, directory);
        models.set(`${profile}/${flavor}`, prepared);
        if (mode === 'check' && flavor === 'pilot') report.models[profile] = await checkModel(profile, definition, prepared, settings, execution.check, output);
      }
      // validateExecution has already checked every scheduled model's
      // invariants and generation bounds; only the mapping can be missing.
      const original = execution.models.find(model => model.path === definition.baseline);
      if (!original?.generate) throw new Error(`${profile}: execution.json schedules no generation for ${definition.baseline}`);
      originals.set(profile, original);
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
        traceBytes: { ...traceBytes, ratio: traceBytes.kernel / traceBytes.baseline }, scheduled: { baseline: baselineRun.scheduled, kernel: pilotRun.scheduled } };
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
    if (mode === 'check') {
      // Cost measurements run after every correctness record is persisted, so a
      // job that is killed mid-measurement (report.json then stays at status
      // running) still carries the histories, replays and faults. Their own
      // failures are recorded here and raised with the sampling bound below.
      for (const [profile, definition] of Object.entries(catalog.profiles)) {
        const original = originals.get(profile);
        try {
          const frozen = await prepareFrozenModel(definition, resolve(output, 'build', profile, 'frozen-monitor'));
          report.exploration[profile] = await measureExploration(profile, { baseline: models.get(`${profile}/baseline`), kernel: models.get(`${profile}/pilot`), frozen },
            settings, original.generate, output, { baselineInvariants: original.invariants, maxRatio: catalog.exploration.maxRatio });
          if (report.exploration[profile].withInvariants.violation) violations.push(report.exploration[profile].withInvariants.violation);
        } catch (error) {
          report.exploration[profile] = { status: 'failed', error: String(error) };
          violations.push(`${profile} exploration: ${error.message}`);
        }
        save(reportPath, report);
        try {
          const { record, problems } = await measureGeneration(profile, models.get(`${profile}/baseline`), models.get(`${profile}/pilot`), settings, original.generate,
            original.invariants, catalog.generation.maxRatio, output);
          report.generation[profile] = record;
          violations.push(...problems);
        } catch (error) {
          report.generation[profile] = { status: 'failed', error: String(error), parity: false };
          violations.push(`${profile} generation: ${error.message}`);
        }
        save(reportPath, report);
      }
    }
    const after = sources();
    const changed = [...new Set([...Object.keys(after), ...Object.keys(report.sources)])].filter(path => after[path] !== report.sources[path]);
    if (changed.length) throw new Error(`Kernel pilot inputs changed during validation: ${changed.join(', ')}`);
    report.sourcesUnchanged = true;
    // Generation parity is the kernel completing the lane's own command within
    // the bound; the pilot records it and does not yet require it.
    if (mode === 'check') report.generationParity = Object.values(report.generation).every(measured => measured.parity === true);
    // The sampling budget fails the check only after every correctness
    // measurement has been recorded.
    if (violations.length) throw new Error(violations.join('\n'));
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
