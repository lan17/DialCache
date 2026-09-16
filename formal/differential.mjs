import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { copySources, importClosure, isKernelSource, isQuintSourcePath, root, validateExecution } from './execution.mjs';
import { parseWithSourceMap, scheduleHistories, spliceDeclarations } from './generated-fixtures.mjs';
import { normalizeReplayInputs } from './replay-inputs.mjs';
import { CommandFailure, printGroup, resolveConcurrency, runPool, seconds, spawnBuffered } from './quint-pool.mjs';
import { parseTrace, profiles } from './replay/features.mjs';
import { generationArguments } from './run-models.mjs';

// Corpus differential for a composed profile (#165).
//
// A profile rewrite must reproduce every history its previous text produced,
// and a library change must not move a composed profile's behavior by
// accident. The reference text (the merge base with a revision, normally the
// base branch) generates the profile's sampled corpus and exports its
// regressions with its own manifest entry and the lane's command; the working
// tree does the same. Every reference history is replayed through the
// candidate text as a deterministic schedule of its public inputs and every
// driver-asserted channel of the step is compared; every candidate history is
// replayed through the reference text the same way, so a candidate that
// enables inputs the reference rejected also disagrees. Trace bytes per state
// may not grow beyond the model's bound; generation wall time is recorded.
//
// An intended change of observable behavior is declared, not smuggled: the
// model's `differential.behaviorVersion` in formal/execution.json (or the
// profile's observation schema version in formal/profiles.json) differs
// between the two revisions, and the profile is reported as an intended
// divergence instead of compared. A profile the reference revision does not
// generate is reported as new.
//
// Replays are batched: one `quint test` process replays a chunk of histories
// through generated runs built from constrained action clones shared across
// the chunk (generated-fixtures.mjs scheduleHistories, the same schedules
// fixture recipes use), each history a cursor-driven step repeated with
// `reps`, because a `.then` chain of eighty steps exceeds the evaluator's
// recursion limit. Per-run cost grows with the schedules a process holds while
// per-process cost shrinks with fewer processes; 16 histories per process
// measured fastest (15.5 s versus 21.9 s for 64 histories at 64 per process).
export const defaultChunk = 16;
export const defaultOutput = '.formal-traces/differential';
export const maxBytesPerStateRatio = 1.2;
export const advisoryWallRatio = 1.5;
export const cursorVariable = 'replayCursor';

const gitShow = (revision, path, cwd) => execFileSync('git', ['show', `${revision}:${path}`], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });

// The reference tree: every Quint source and the manifests at the revision,
// checked out into a scratch directory so relative imports resolve as in the repo.
const manifestPaths = ['formal/execution.json', 'formal/profiles.json'];
export function exportRevision(revision, directory, { cwd = root } = {}) {
  const listing = execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', 'formal'], { cwd, encoding: 'utf8' })
    .split('\n').filter(path => manifestPaths.includes(path) || isQuintSourcePath(path));
  if (!listing.includes('formal/execution.json')) throw new Error(`Revision ${revision} has no formal/execution.json`);
  for (const path of listing) {
    mkdirSync(resolve(directory, dirname(path)), { recursive: true });
    writeFileSync(resolve(directory, path), gitShow(revision, path, cwd));
  }
  return listing;
}

export function resolveMergeBase(revision, { cwd = root } = {}) {
  return execFileSync('git', ['merge-base', 'HEAD', revision], { cwd, encoding: 'utf8' }).trim();
}

// The reference manifests are read as recorded at their revision and checked
// only for the shape this tool consumes; the working tree's validator applies
// to the working tree's inventory, not to another revision's.
export function readManifests(directory) {
  const execution = JSON.parse(readFileSync(resolve(directory, 'formal/execution.json'), 'utf8'));
  const registry = JSON.parse(readFileSync(resolve(directory, 'formal/profiles.json'), 'utf8'));
  if (!Array.isArray(execution.models) || !execution.settings || !Array.isArray(registry.profiles)) throw new Error(`${directory}: unsupported manifests`);
  return { execution, registry };
}
function generationModel(manifests, profileId) {
  const model = manifests.execution.models.find(candidate => candidate.profile === profileId);
  if (!model || !model.generate || typeof model.path !== 'string' || !Array.isArray(model.invariants)) return undefined;
  const entry = manifests.registry.profiles.find(candidate => candidate.id === profileId);
  return { ...model, behaviorVersion: model.differential?.behaviorVersion ?? 0, schemaVersion: entry?.version ?? null, settings: manifests.execution.settings };
}

// What to do for one profile given both revisions' manifests. A profile the
// candidate no longer generates is a visible removal with no behavior left to
// protect (the manifest validator forbids registering a profile without
// generating it), so it is reported, not compared.
export function differentialPlan(referenceManifests, candidateManifests, profileId) {
  const candidate = generationModel(candidateManifests, profileId);
  const reference = generationModel(referenceManifests, profileId);
  if (!candidate && !reference) throw new Error(`No generation profile named ${profileId} in either revision's formal/execution.json`);
  if (!candidate) return { action: 'skip', reason: 'profile removed: the candidate does not generate it', reference };
  const descriptor = profiles[profileId];
  if (!descriptor || !descriptor.explicitInputs) throw new Error(`Profile ${profileId} has no explicit-input feature descriptor in formal/replay/features.mjs; the differential replays explicit inputs only`);
  if (!reference) return { action: 'skip', reason: 'new profile: the reference revision does not generate it', candidate, descriptor };
  if (reference.behaviorVersion !== candidate.behaviorVersion) {
    return { action: 'skip', reason: `intended divergence: behaviorVersion ${reference.behaviorVersion} -> ${candidate.behaviorVersion}`, reference, candidate, descriptor };
  }
  if (reference.schemaVersion !== candidate.schemaVersion) {
    return { action: 'skip', reason: `intended divergence: observation schema version ${reference.schemaVersion} -> ${candidate.schemaVersion}`, reference, candidate, descriptor };
  }
  return { action: 'compare', reference, candidate, descriptor };
}

// The step-by-step comparison. Inputs are compared first; then every asserted
// channel of the step, naming the differing channel and field.
function differing(expected, actual, prefix = '') {
  if (isDeepStrictEqual(expected, actual)) return [];
  const composite = value => value !== null && typeof value === 'object';
  if (composite(expected) && composite(actual) && Array.isArray(expected) === Array.isArray(actual)) {
    const keys = Array.isArray(expected) ? [...Array(Math.max(expected.length, actual.length)).keys()] : Object.keys({ ...expected, ...actual }).sort();
    return keys.flatMap(key => differing(expected[key], actual[key], `${prefix}${key}.`));
  }
  return [`${prefix.slice(0, -1)} ${JSON.stringify(actual)} (reference ${JSON.stringify(expected)})`];
}
export function compareHistory(reference, replayed) {
  const length = Math.min(reference.steps.length, replayed.steps.length);
  for (let index = 0; index < length; index++) {
    const { action, choice, ...expected } = reference.steps[index];
    const { action: replayedAction, choice: replayedChoice, ...actual } = replayed.steps[index];
    if (action !== replayedAction || choice !== replayedChoice) {
      return { agree: false, step: index, reason: `input ${replayedAction}/${replayedChoice} replaces ${action}/${choice}` };
    }
    const fields = differing(expected, actual);
    if (fields.length) {
      return { agree: false, step: index, action, choice, fields: fields.map(field => field.split(' ')[0]),
        reason: `observation differs after ${action}/${choice} at step ${index}: ${fields.join('; ')}` };
    }
  }
  if (reference.steps.length !== replayed.steps.length) {
    const refused = reference.steps[length];
    return { agree: false, step: length, ...(refused ? { action: refused.action, choice: refused.choice } : {}),
      reason: refused ? `${refused.action}/${refused.choice} refused at step ${length} (replay has ${replayed.steps.length} states, reference ${reference.steps.length})`
        : `replay has ${replayed.steps.length} states, reference ${reference.steps.length}` };
  }
  return { agree: true };
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

// Bytes per state over a directory of traces: the trace-size signal the
// migration criteria bound (a rewrite must not grow what every reader parses).
export function bytesPerState(directory) {
  let bytes = 0, states = 0, traces = 0;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith('.itf.json')) continue;
    const text = readFileSync(resolve(directory, name), 'utf8');
    bytes += Buffer.byteLength(text);
    states += JSON.parse(text).states.length;
    traces++;
  }
  return { traces, states, bytes, bytesPerState: states ? bytes / states : 0 };
}

export function chunked(items, size) {
  const chunks = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

async function quint(args, { cwd, timeoutMs = 900_000 }) {
  const result = await spawnBuffered('quint', args, { cwd, timeoutMs });
  if (result.error) throw new CommandFailure(`quint ${args[0]} failed to run: ${result.error.message}`, result);
  return result;
}

// As in the generation lane: the explicit input record is authoritative, and
// the simulator's action and choice annotations are rewritten from it (the
// simulator can stamp a stale action on a trace's initial state; a test export
// carries no annotations at all).
export function normalizeGeneratedTraces(folders) {
  let normalized = 0;
  for (const folder of folders) {
    for (const name of readdirSync(folder).filter(name => name.endsWith('.itf.json'))) {
      const path = resolve(folder, name);
      writeFileSync(path, JSON.stringify(normalizeReplayInputs(JSON.parse(readFileSync(path, 'utf8')))) + '\n');
      normalized++;
    }
  }
  return normalized;
}

// Generate a tree's corpus and exported regressions with that tree's own
// manifest entry: the lane's command, seed, invariants and bounds as recorded there.
export async function generateCorpus(tree, model, { timeoutMs } = {}) {
  const outputDirectory = model.generate.outputDirectory;
  const directory = resolve(tree, outputDirectory);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const args = generationArguments(model.path, model.generate, model.invariants, { settings: model.settings, seed: model.settings.seed, outputDirectory });
  const generation = await quint(args, { cwd: tree, timeoutMs });
  if (generation.status !== 0) throw new CommandFailure(`generation of ${model.path} failed (exit ${generation.status}):\n${generation.stderr}${generation.stdout}`, generation);
  const regressions = `${outputDirectory}-regressions`;
  let exported = { durationMs: 0 };
  rmSync(resolve(tree, regressions), { recursive: true, force: true });
  mkdirSync(resolve(tree, regressions), { recursive: true });
  if (model.replayRegressions?.length) {
    exported = await quint(['test', model.path, `--backend=${model.settings.backend}`, '--max-samples=1', `--seed=${model.settings.seed}`,
      `--match=^(${model.replayRegressions.join('|')})$`, `--out-itf=${regressions}/{test}.itf.json`], { cwd: tree, timeoutMs });
    if (exported.status !== 0) throw new CommandFailure(`regression export of ${model.path} failed (exit ${exported.status}):\n${exported.stderr}${exported.stdout}`, exported);
  }
  const files = readdirSync(directory).filter(name => name.endsWith('.itf.json'));
  if (files.length !== model.generate.traces) throw new Error(`${model.path} generated ${files.length} traces, expected ${model.generate.traces}`);
  normalizeGeneratedTraces([directory, resolve(tree, regressions)]);
  return { directory, regressions: resolve(tree, regressions), generationMs: generation.durationMs, regressionMs: exported.durationMs,
    log: generation.stdout + generation.stderr };
}

export function loadHistories(directory, descriptor) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.itf.json')).sort()
    .map(name => parseTrace(JSON.parse(readFileSync(resolve(directory, name), 'utf8')), name, descriptor));
}

// A run that stops early still writes its trace: the agreeing prefix plus one
// trailing state that carries only #meta. Only states recording a step count.
export function recordedStates(raw) {
  const states = Array.isArray(raw.states) ? raw.states : [];
  let end = states.length;
  while (end > 0 && (states[end - 1].s === undefined || states[end - 1].input === undefined)) end--;
  return { ...raw, states: states.slice(0, end) };
}

// The evaluator's diagnostic for one failed run in a `quint test` log:
// `N) <run>:` followed by the error line.
export function runDiagnostic(log, run) {
  const match = new RegExp(`^\\s*\\d+\\)\\s+${run}:\\s*\\n([\\s\\S]*?)(?=^\\s*\\d+\\)\\s+\\w+:|$(?![\\s\\S]))`, 'm').exec(log);
  const line = match?.[1].split('\n').map(text => text.trim()).find(text => /QNT\d+|error/i.test(text));
  return line ?? null;
}

// Replay histories through a tree's text in chunks; one verdict per history in
// input order. `model` is the tree's own manifest entry.
export async function replayHistories(tree, model, descriptor, histories, { chunk, output, concurrency }) {
  const prepared = await prepareReplay(tree, model, descriptor, histories, { chunk, output });
  return prepared.collect(await runPool(prepared.tasks, { concurrency }));
}

// The replay as pool tasks, so both directions of a differential share one
// pool: `tasks` are the chunk thunks and `collect` places their results.
export async function prepareReplay(tree, model, descriptor, histories, { chunk, output }) {
  if (!histories.length) return { tasks: [], collect: () => [] };
  const parseDirectory = mkdtempSync(resolve(tmpdir(), 'dialcache-differential-parse-'));
  let parsed, sourceMap;
  try {
    ({ parsed, sourceMap } = await parseWithSourceMap(model.path, parseDirectory, async args => {
      const result = await quint(args, { cwd: tree });
      if (result.status !== 0) throw new CommandFailure(`quint parse ${model.path} failed:\n${result.stderr}`, result);
    }));
  } finally { rmSync(parseDirectory, { recursive: true, force: true }); }
  const moduleName = parsed.modules.at(-1).name;
  const declarations = new Map(parsed.modules.find(candidate => candidate.name === moduleName).declarations.map(declaration => [declaration.name, declaration]));
  const source = readFileSync(resolve(tree, model.path), 'utf8');
  // A history whose input the tree has no public action for cannot be
  // scheduled: it disagrees at that step; the others are replayed.
  const verdicts = new Array(histories.length);
  const scheduled = [];
  histories.forEach((history, index) => {
    const unknown = history.steps.findIndex(step => !declarations.has(step.action));
    if (unknown === -1) scheduled.push({ history, index });
    else verdicts[index] = { path: history.path, agree: false, step: unknown, action: history.steps[unknown].action, choice: history.steps[unknown].choice,
      reason: `${moduleName} has no public action ${history.steps[unknown].action} (step ${unknown})` };
  });
  const tasks = chunked(scheduled, chunk).map((batch, position) => async () => {
    const workspace = resolve(output, `replay-${position}`);
    rmSync(workspace, { recursive: true, force: true });
    copySources(tree, workspace);
    const schedule = scheduleHistories(source, declarations, sourceMap, batch.map(({ history }) => history.steps.map(step => [step.action, step.choice])),
      { prefix: 'replay', cursor: cursorVariable });
    const runs = schedule.schedules.flatMap((entry, index) => [
      ...(entry.steps ? [`action replaySchedule${index} = ${entry.step}`] : []),
      `run replay${index} = ${entry.steps ? `(${entry.init}).then((${entry.steps}).reps(_ => replaySchedule${index}))` : entry.init}`,
    ]);
    const modelPath = resolve(workspace, model.path);
    writeFileSync(modelPath, spliceDeclarations(source, [...schedule.declarations, ...runs]));
    const traces = resolve(workspace, 'traces');
    mkdirSync(traces);
    // A chunk replays in seconds; a stuck evaluator should not hold the job.
    const test = await quint(['test', modelPath, `--backend=${model.settings.backend}`, '--max-samples=1', `--seed=${model.settings.seed}`,
      '--match=^replay\\d+$', `--out-itf=${traces}/{test}.itf.json`], { cwd: workspace, timeoutMs: 300_000 });
    const log = test.stdout + test.stderr;
    writeFileSync(resolve(workspace, 'quint-test.log'), log);
    const verdictsOfChunk = batch.map(({ history, index: position }, index) => {
      const file = resolve(traces, `replay${index}.itf.json`);
      const diagnostic = runDiagnostic(log, `replay${index}`);
      const withDiagnostic = verdict => ({ path: history.path, ...verdict, ...(verdict.agree || !diagnostic ? {} : { reason: `${verdict.reason}; ${diagnostic}` }) });
      if (!existsSync(file)) return [position, withDiagnostic({ agree: false, step: 0, reason: `no replay trace (quint test exit ${test.status}); see ${workspace}/quint-test.log` })];
      let replayed;
      try { replayed = replayedHistory(JSON.parse(readFileSync(file, 'utf8')), history, descriptor); }
      catch (error) { return [position, withDiagnostic({ agree: false, step: 0, reason: `replay trace unreadable: ${error.message}` })]; }
      return [position, withDiagnostic(compareHistory(history, replayed))];
    });
    // Agreeing traces are not evidence anyone reads again; disagreements stay.
    if (verdictsOfChunk.every(([, verdict]) => verdict.agree)) rmSync(traces, { recursive: true, force: true });
    return verdictsOfChunk;
  });
  return { tasks, collect: results => { for (const [position, verdict] of results.flat()) verdicts[position] = verdict; return verdicts; } };
}

// The replayed history a trace records. A run refused at its first input or
// at init leaves fewer than the two states a trace needs: one recorded state
// is the initialization the reference also took, none is a refused init.
export function replayedHistory(raw, reference, descriptor) {
  const recorded = recordedStates(raw);
  if (recorded.states.length >= 2) return parseTrace(recorded, reference.path, descriptor);
  return { path: reference.path, steps: recorded.states.length === 1 ? reference.steps.slice(0, 1) : [] };
}

// Per-file digests over a model's import closure: the provenance a compared
// or skipped report records, and what the unchanged-closure skip compares.
export function closureDigests(path, { cwd = root } = {}) {
  return Object.fromEntries(importClosure(path, cwd).map(source => [source, sha256(readFileSync(resolve(cwd, source), 'utf8'))]));
}

// The profiles the differential applies to: every generation profile whose
// text, directly or through a helper library, imports a kernel module.
export function composedProfiles(manifest, { cwd = root } = {}) {
  return manifest.models.filter(model => model.profile !== undefined && importClosure(model.path, cwd).some(isKernelSource)).map(model => model.profile);
}

// The two trees of a run, prepared once: the reference is the merge base with
// a revision (its Quint sources and manifests exported as recorded), the
// candidate is a copy of the working tree with its manifests validated.
export function prepare(reference, { cwd = root, output = defaultOutput } = {}) {
  const candidateManifests = readManifests(cwd);
  validateExecution(candidateManifests.execution);
  const revision = resolveMergeBase(reference, { cwd });
  for (const stale of ['reference', 'candidate']) rmSync(resolve(cwd, output, stale), { recursive: true, force: true });
  const referenceTree = resolve(cwd, output, 'reference', revision.slice(0, 12));
  exportRevision(revision, referenceTree, { cwd });
  const candidateTree = resolve(cwd, output, 'candidate');
  copySources(cwd, candidateTree);
  return { reference: { revision, tree: referenceTree, manifests: readManifests(referenceTree) }, candidate: { tree: candidateTree, manifests: candidateManifests } };
}

// The profiles a run replays: every profile composed in either revision, so a
// rewrite that moves a profile off the library is checked like one that moves
// it on. A profile composed at the reference that the candidate no longer
// generates is selected too and reported as removed (the manifest validators
// own whether a profile may disappear; the differential only makes it visible).
export function selectProfiles(prepared) {
  return [...new Set([...composedProfiles(prepared.reference.manifests.execution, { cwd: prepared.reference.tree }),
    ...composedProfiles(prepared.candidate.manifests.execution, { cwd: prepared.candidate.tree })])].sort();
}

// A generation whose inputs are byte-identical in both revisions is the same
// deterministic computation under the pinned Quint and seed: nothing to compare.
export function closureSkip(referenceModel, candidateModel, referenceSources, candidateSources) {
  const generationInputs = model => ({ settings: model.settings, generate: model.generate, invariants: model.invariants, replayRegressions: model.replayRegressions ?? [] });
  return isDeepStrictEqual(referenceSources, candidateSources) && isDeepStrictEqual(generationInputs(referenceModel), generationInputs(candidateModel))
    ? 'identical import closure and generation settings' : null;
}

// The differential for one profile over the prepared trees.
export async function runDifferential(profileId, prepared, { chunk = defaultChunk, output = defaultOutput,
    concurrency = resolveConcurrency(), cwd = root, log = console.log } = {}) {
  const { revision, tree: referenceTree, manifests: referenceManifests } = prepared.reference;
  const { tree: candidateTree, manifests: candidateManifests } = prepared.candidate;
  const outputDirectory = resolve(cwd, output, profileId);
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  const write = report => { writeFileSync(resolve(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n'); return report; };
  const entry = model => model ? { path: model.path, behaviorVersion: model.behaviorVersion, schemaVersion: model.schemaVersion } : {};
  const plan = differentialPlan(referenceManifests, candidateManifests, profileId);
  const base = { schemaVersion: 2, profile: profileId, reference: { revision, ...entry(plan.reference) }, candidate: entry(plan.candidate) };
  if (plan.action === 'skip') return write({ ...base, skipped: plan.reason });
  const { reference: referenceModel, candidate: candidateModel, descriptor } = plan;
  const referenceSources = closureDigests(referenceModel.path, { cwd: referenceTree });
  const candidateSources = closureDigests(candidateModel.path, { cwd: candidateTree });
  const withSources = { ...base, reference: { ...base.reference, sources: referenceSources }, candidate: { ...base.candidate, sources: candidateSources } };
  const unchanged = closureSkip(referenceModel, candidateModel, referenceSources, candidateSources);
  if (unchanged) return write({ ...withSources, skipped: unchanged });
  log(`Corpus differential for ${profileId}: reference ${revision.slice(0, 12)} (${referenceModel.path}), candidate working tree (${candidateModel.path}).`);
  const [referenceCorpus, candidateCorpus] = await Promise.all([
    generateCorpus(referenceTree, referenceModel),
    generateCorpus(candidateTree, candidateModel),
  ]);
  printGroup(`Reference generation (${seconds(referenceCorpus.generationMs)})`, referenceCorpus.log);
  printGroup(`Candidate generation (${seconds(candidateCorpus.generationMs)})`, candidateCorpus.log);
  const label = (histories, prefix) => histories.map(history => ({ ...history, path: `${prefix}${history.path}` }));
  const referenceHistories = [...loadHistories(referenceCorpus.directory, descriptor), ...label(loadHistories(referenceCorpus.regressions, descriptor), 'regression:')];
  const candidateHistories = [...loadHistories(candidateCorpus.directory, descriptor), ...label(loadHistories(candidateCorpus.regressions, descriptor), 'regression:')];
  log(`Replaying ${referenceHistories.length} reference histories through the candidate and ${candidateHistories.length} candidate histories through the reference, ${chunk} per process.`);
  const started = performance.now();
  const forwardReplay = await prepareReplay(candidateTree, candidateModel, descriptor, referenceHistories, { chunk, output: resolve(outputDirectory, 'forward') });
  const reverseReplay = await prepareReplay(referenceTree, referenceModel, descriptor, candidateHistories, { chunk, output: resolve(outputDirectory, 'reverse') });
  const results = await runPool([...forwardReplay.tasks, ...reverseReplay.tasks], { concurrency });
  const forward = forwardReplay.collect(results.slice(0, forwardReplay.tasks.length));
  const reverse = reverseReplay.collect(results.slice(forwardReplay.tasks.length));
  const replayMs = performance.now() - started;
  const direction = (name, verdicts, sampled, regressions) => ({ sampled, regressions, agreed: verdicts.filter(verdict => verdict.agree).length,
    disagreed: verdicts.filter(verdict => !verdict.agree).length, disagreements: verdicts.filter(verdict => !verdict.agree).slice(0, 20).map(verdict => ({ direction: name, ...verdict })) });
  const referenceSize = bytesPerState(referenceCorpus.directory);
  const candidateSize = bytesPerState(candidateCorpus.directory);
  return write({
    ...withSources,
    forward: direction('forward', forward, referenceHistories.length - referenceHistories.filter(history => history.path.startsWith('regression:')).length, referenceHistories.filter(history => history.path.startsWith('regression:')).length),
    reverse: direction('reverse', reverse, candidateHistories.length - candidateHistories.filter(history => history.path.startsWith('regression:')).length, candidateHistories.filter(history => history.path.startsWith('regression:')).length),
    generation: { referenceMs: Math.round(referenceCorpus.generationMs), candidateMs: Math.round(candidateCorpus.generationMs),
      wallRatio: referenceCorpus.generationMs ? candidateCorpus.generationMs / referenceCorpus.generationMs : null,
      reference: referenceSize, candidate: candidateSize,
      bytesPerStateRatio: referenceSize.bytesPerState ? candidateSize.bytesPerState / referenceSize.bytesPerState : null,
      maxBytesPerStateRatio },
    replay: { chunk, wallMs: Math.round(replayMs) },
  });
}

// The run's verdict: any disagreement in either direction fails, as does trace
// growth beyond the bound. Wall time is advisory: the two generations run
// concurrently and hosted runners are noisy.
export function verdict(report) {
  const reasons = [];
  if (report.skipped) return { failed: false, reasons: [`skipped: ${report.skipped}`] };
  for (const name of ['forward', 'reverse']) if (report[name].disagreed) reasons.push(`${report[name].disagreed} ${name} disagreement(s)`);
  const ratio = report.generation.bytesPerStateRatio;
  if (ratio !== null && ratio > report.generation.maxBytesPerStateRatio) reasons.push(`bytes per state grew x${ratio.toFixed(3)}, above the bound x${report.generation.maxBytesPerStateRatio}`);
  const advisory = report.generation.wallRatio !== null && report.generation.wallRatio > advisoryWallRatio
    ? [`advisory: generation wall time x${report.generation.wallRatio.toFixed(2)} exceeds x${advisoryWallRatio} (concurrent generations; not gated)`] : [];
  return { failed: reasons.length > 0, reasons: [...reasons, ...advisory] };
}

const ratio = (value, digits) => value === null || value === undefined ? 'ratio unavailable' : `x${value.toFixed(digits)}`;
export function formatReport(report) {
  if (report.skipped) return `${report.profile}: not compared (${report.skipped}).`;
  const total = direction => direction.sampled + direction.regressions;
  const lines = [
    `${report.profile}: forward ${report.forward.agreed} of ${total(report.forward)} reference histories agree through the candidate` +
      ` (${report.forward.sampled} sampled, ${report.forward.regressions} regressions); reverse ${report.reverse.agreed} of ${total(report.reverse)} candidate histories agree through the reference;` +
      ` replay ${seconds(report.replay.wallMs)} at ${report.replay.chunk} per process.`,
    `generation wall ${seconds(report.generation.referenceMs)} -> ${seconds(report.generation.candidateMs)} (${ratio(report.generation.wallRatio, 2)}, advisory),` +
      ` bytes/state ${report.generation.reference.bytesPerState.toFixed(0)} -> ${report.generation.candidate.bytesPerState.toFixed(0)}` +
      ` (${ratio(report.generation.bytesPerStateRatio, 3)}, bound x${report.generation.maxBytesPerStateRatio})`,
  ];
  for (const name of ['forward', 'reverse']) {
    for (const disagreement of report[name].disagreements) lines.push(`  ${name} ${disagreement.path}: ${disagreement.reason}`);
    if (report[name].disagreed > report[name].disagreements.length) lines.push(`  ... ${report[name].disagreed - report[name].disagreements.length} more ${name}`);
  }
  for (const reason of verdict(report).reasons) lines.push(`  ${reason}`);
  return lines.join('\n');
}

const usage = `Usage: node formal/differential.mjs <profile> | --composed [--reference=<revision>] [--chunk=<n>] [--out=<directory>]

Generates <profile>'s corpus and exported regressions from the merge base with
<revision> (default origin/main) and from the working tree, each with its own
manifest entry and the lane's command; replays every reference history through
the working tree's text and every working-tree history through the reference
text; fails on any step whose driver-asserted observation differs, on an input
either text refuses, or on trace bytes per state above x${maxBytesPerStateRatio}.
A profile whose differential.behaviorVersion or observation schema version
differs between the revisions is reported as an intended divergence and not
compared; a profile the reference does not generate is reported as new.
A profile whose import closure and generation settings are byte-identical in
both revisions is reported as unchanged and not regenerated. --composed selects
every profile that imports a kernel module in either revision; one the working
tree no longer generates is reported as removed. Only profiles with an
explicit-input driver descriptor (formal/replay/features.mjs) can be replayed.
Reports:
report.json under --out (default ${defaultOutput}/<profile>).`;

async function main(argv) {
  const options = {}, positional = [];
  for (const argument of argv) {
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const separator = argument.indexOf('=');
    if (separator === -1) options[argument.slice(2)] = true; else options[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  if (options.help || (positional.length !== 1 && !options.composed) || (positional.length && options.composed)) { console.log(usage); return 2; }
  const chunk = options.chunk === undefined ? defaultChunk : Number(options.chunk);
  if (!Number.isSafeInteger(chunk) || chunk < 1) throw new Error('--chunk must be a positive integer');
  const settings = { chunk, ...(typeof options.out === 'string' ? { output: options.out } : {}) };
  const prepared = prepare(typeof options.reference === 'string' ? options.reference : 'origin/main', { output: settings.output ?? defaultOutput });
  const selected = options.composed ? selectProfiles(prepared) : positional;
  if (!selected.length) { console.log('No profile imports a kernel module in either revision; nothing to replay.'); return 0; }
  console.log(`Reference ${prepared.reference.revision.slice(0, 12)}; profiles: ${selected.join(', ')}.`);
  let failed = false;
  for (const profileId of selected) {
    const report = await runDifferential(profileId, prepared, settings);
    console.log(formatReport(report));
    if (verdict(report).failed) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof CommandFailure || error instanceof Error ? error.message : error);
    process.exitCode = typeof error?.status === 'number' && error.status > 0 ? error.status : 1;
  });
}
