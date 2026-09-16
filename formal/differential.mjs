import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { readExecution, root, validateExecution } from './execution.mjs';
import { constrainAction } from './generated-fixtures.mjs';
import { CommandFailure, printGroup, resolveConcurrency, runPool, seconds, spawnBuffered } from './quint-pool.mjs';
import { profiles } from './replay/features.mjs';
import { generationArguments } from './run-models.mjs';

// Corpus differential for a profile rewrite (#165).
//
// A rewritten profile must reproduce every history its previous text produced:
// the reference text (a git revision, normally the merge base) generates the
// profile's sampled corpus and exports its regressions with the lane's own
// command and seed; every history is then replayed through the working tree's
// text as a deterministic schedule of its public inputs, and the driver-
// asserted observation is compared at every step. Any disagreement fails.
//
// Replays are batched: one `quint test` process replays a chunk of histories
// through generated runs built from constrained action clones (the same
// constraint generated-fixtures.mjs applies to fixture recipes). Each history
// becomes a flat scheduler action selected by a cursor and repeated with
// `reps`, because a `.then` chain of eighty steps exceeds the evaluator's
// recursion limit and one process holding hundreds of runs grows superlinearly.
//
// Cost is measured in the same job: the reference and the candidate generate
// the corpus with identical arguments, and the report records the wall-time
// and bytes-per-state ratios the migration criteria bound.
export const defaultChunk = 64;
export const defaultOutput = '.formal-traces/differential';
export const cursorVariable = 'replayCursor';

export function quintSources(directory) {
  const files = [];
  for (const relativeDirectory of ['formal', 'formal/kernel']) {
    const absolute = resolve(directory, relativeDirectory);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute)) if (name.endsWith('.qnt')) files.push(`${relativeDirectory}/${name}`);
  }
  return files.sort();
}

// The reference tree: every Quint source at the given revision, checked out
// into a scratch directory so relative imports resolve as they do in the repo.
export function exportRevision(revision, directory, { cwd = root } = {}) {
  const listing = execFileSync('git', ['ls-tree', '-r', '--name-only', revision, '--', 'formal'], { cwd, encoding: 'utf8' })
    .split('\n').filter(path => /^formal\/(kernel\/)?[\w-]+\.qnt$/.test(path));
  if (!listing.length) throw new Error(`Revision ${revision} has no Quint sources under formal/`);
  for (const path of listing) {
    const text = execFileSync('git', ['show', `${revision}:${path}`], { cwd, encoding: 'utf8', maxBuffer: 1 << 26 });
    mkdirSync(resolve(directory, dirname(path)), { recursive: true });
    writeFileSync(resolve(directory, path), text);
  }
  return listing;
}

export function copySources(from, to) {
  const files = quintSources(from);
  for (const path of files) {
    mkdirSync(resolve(to, dirname(path)), { recursive: true });
    writeFileSync(resolve(to, path), readFileSync(resolve(from, path)));
  }
  return files;
}

export function resolveMergeBase(revision, { cwd = root } = {}) {
  return execFileSync('git', ['merge-base', 'HEAD', revision], { cwd, encoding: 'utf8' }).trim();
}

// One history: the public inputs the trace recorded and the observation the
// drivers assert after each of them.
export function historyOf(raw, path, profile) {
  const { parseTrace } = featureParsers;
  const trace = parseTrace(raw, path, profile);
  return { path, steps: trace.steps.map(step => ({ action: step.action, choice: step.choice, expected: step.expected })) };
}
const featureParsers = await import('./replay/features.mjs');

export function parsedModule(parsed, name) {
  const module = parsed.modules.find(candidate => candidate.name === name);
  if (!module) throw new Error(`Parsed output has no module ${name}`);
  return module;
}

// A replay module: the candidate profile text plus, before its closing brace,
// a cursor variable, one constrained clone per distinct (action, choice) and,
// per history, a scheduler action and a run. `initClone` replaces the model's
// own `init` so the fixture choice is the history's.
export function replayModule(source, declarations, sourceMap, histories, { module }) {
  const clones = new Map();
  const additions = [];
  const clone = (action, choice) => {
    const key = `${action}/${choice}`;
    if (!clones.has(key)) {
      const declaration = declarations.get(action);
      if (!declaration) throw new Error(`${module} has no public action ${action}`);
      const name = `replayAction${clones.size}`;
      additions.push(`  action ${name} = ${constrainAction(source, declaration, sourceMap, choice)}`);
      clones.set(key, name);
    }
    return clones.get(key);
  };
  const runs = [];
  for (const [position, history] of histories.entries()) {
    const calls = history.steps.map(step => clone(step.action, step.choice));
    const scheduled = calls.slice(1).map((call, cursor) => `all { ${cursorVariable} == ${cursor}, ${call}, ${cursorVariable}' = ${cursor + 1} }`);
    runs.push(`  action replaySchedule${position} = any { ${scheduled.join(', ')} }`);
    runs.push(`  run replay${position} = all { ${calls[0]}, ${cursorVariable}' = 0 }.then((${calls.length - 1}).reps(_ => replaySchedule${position}))`);
  }
  const end = source.lastIndexOf('}');
  if (end === -1) throw new Error('Candidate module has no closing brace');
  const text = `${source.slice(0, end)}\n  var ${cursorVariable}: int\n${additions.join('\n')}\n${runs.join('\n')}\n${source.slice(end)}`;
  return { text, clones: clones.size, runs: histories.length };
}

// Step-by-step comparison; the first disagreement names the step, the input
// and the observation fields that differ.
export function compareHistory(reference, replayed) {
  const length = Math.min(reference.steps.length, replayed.steps.length);
  for (let index = 0; index < length; index++) {
    const expected = reference.steps[index], actual = replayed.steps[index];
    if (expected.action !== actual.action || expected.choice !== actual.choice) {
      return { agree: false, step: index, reason: `input ${actual.action}/${actual.choice} replaces ${expected.action}/${expected.choice}` };
    }
    if (!isDeepStrictEqual(expected.expected, actual.expected)) {
      const fields = Object.keys({ ...expected.expected, ...actual.expected })
        .filter(field => !isDeepStrictEqual(expected.expected[field], actual.expected[field])).sort();
      return { agree: false, step: index, action: expected.action, choice: expected.choice, fields,
        reason: `observation differs after ${expected.action}/${expected.choice} at step ${index}: ${fields.map(field =>
          `${field} ${JSON.stringify(actual.expected[field])} (reference ${JSON.stringify(expected.expected[field])})`).join('; ')}` };
    }
  }
  if (reference.steps.length !== replayed.steps.length) {
    return { agree: false, step: length, reason: `replay has ${replayed.steps.length} states, reference ${reference.steps.length}` };
  }
  return { agree: true };
}

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

// Bytes per state over a directory of traces: the generation-cost signal the
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

export async function generateCorpus(tree, model, { seed, outputDirectory, timeoutMs }) {
  const manifest = model.manifest;
  const directory = resolve(tree, outputDirectory);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const args = generationArguments(model.path, model.generate, model.invariants, { settings: manifest.settings, seed, outputDirectory });
  const generation = await quint(args, { cwd: tree, timeoutMs });
  if (generation.status !== 0) throw new CommandFailure(`generation of ${model.path} failed (exit ${generation.status}):\n${generation.stderr}${generation.stdout}`, generation);
  const regressions = `${outputDirectory}-regressions`;
  let exported = { durationMs: 0 };
  if (model.replayRegressions?.length) {
    rmSync(resolve(tree, regressions), { recursive: true, force: true });
    mkdirSync(resolve(tree, regressions), { recursive: true });
    exported = await quint(['test', model.path, `--backend=${manifest.settings.backend}`, '--max-samples=1', `--seed=${seed}`,
      `--match=^(${model.replayRegressions.join('|')})$`, `--out-itf=${regressions}/{test}.itf.json`], { cwd: tree, timeoutMs });
    if (exported.status !== 0) throw new CommandFailure(`regression export of ${model.path} failed (exit ${exported.status}):\n${exported.stderr}${exported.stdout}`, exported);
  }
  const files = readdirSync(directory).filter(name => name.endsWith('.itf.json')).sort();
  if (files.length !== model.generate.traces) throw new Error(`${model.path} generated ${files.length} traces, expected ${model.generate.traces}`);
  return { directory, regressions: resolve(tree, regressions), generationMs: generation.durationMs, regressionMs: exported.durationMs,
    log: generation.stdout + generation.stderr };
}

export function loadHistories(directory, profile) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter(name => name.endsWith('.itf.json')).sort()
    .map(name => historyOf(JSON.parse(readFileSync(resolve(directory, name), 'utf8')), name, profile));
}

// Replay every history through the candidate text in chunks; returns one
// verdict per history in input order.
export async function replayHistories(candidateTree, model, profile, histories, { chunk, seed, output, concurrency }) {
  if (!histories.length) return [];
  const parseDirectory = mkdtempSync(resolve(tmpdir(), 'dialcache-differential-parse-'));
  let parsed, sourceMap;
  try {
    const parse = await quint(['parse', model.path, `--out=${parseDirectory}/parsed.json`, `--source-map=${parseDirectory}/map.json`], { cwd: candidateTree });
    if (parse.status !== 0) throw new CommandFailure(`quint parse ${model.path} failed:\n${parse.stderr}`, parse);
    parsed = JSON.parse(readFileSync(`${parseDirectory}/parsed.json`, 'utf8'));
    sourceMap = JSON.parse(readFileSync(`${parseDirectory}/map.json`, 'utf8'));
  } finally { rmSync(parseDirectory, { recursive: true, force: true }); }
  const moduleName = parsed.modules.at(-1).name;
  const declarations = new Map(parsedModule(parsed, moduleName).declarations.map(declaration => [declaration.name, declaration]));
  const source = readFileSync(resolve(candidateTree, model.path), 'utf8');
  const chunks = chunked(histories, chunk);
  const results = await runPool(chunks.map((batch, position) => async () => {
    const workspace = resolve(output, `replay-${position}`);
    rmSync(workspace, { recursive: true, force: true });
    copySources(candidateTree, workspace);
    const replay = replayModule(source, declarations, sourceMap, batch, { module: moduleName });
    const modelPath = resolve(workspace, model.path);
    writeFileSync(modelPath, replay.text);
    const traces = resolve(workspace, 'traces');
    mkdirSync(traces);
    const test = await quint(['test', modelPath, `--backend=${model.manifest.settings.backend}`, '--max-samples=1', `--seed=${seed}`,
      '--match=^replay\\d+$', `--out-itf=${traces}/{test}.itf.json`], { cwd: workspace });
    writeFileSync(resolve(workspace, 'quint-test.log'), test.stdout + test.stderr);
    return batch.map((history, index) => {
      const file = resolve(traces, `replay${index}.itf.json`);
      if (!existsSync(file)) return { path: history.path, agree: false, step: 0, reason: `no replay trace (quint test exit ${test.status}); see ${workspace}/quint-test.log` };
      let replayed;
      try { replayed = historyOf(JSON.parse(readFileSync(file, 'utf8')), history.path, profile); }
      catch (error) { return { path: history.path, agree: false, step: 0, reason: `replay trace unreadable: ${error.message}` }; }
      return { path: history.path, ...compareHistory(history, replayed) };
    });
  }), { concurrency });
  return results.flat();
}

// The profiles the differential applies to: every generation profile whose
// text imports a kernel module. The set follows the migration by itself.
export function composedProfiles(manifest, { cwd = root } = {}) {
  return manifest.models.filter(model => model.profile !== undefined &&
    /^\s*import\s+\w+(\.\*|\s+as\s+\w+)\s+from\s+"\.\/kernel\//m.test(readFileSync(resolve(cwd, model.path), 'utf8'))).map(model => model.profile);
}

export function differentialModel(manifest, profileId) {
  const model = manifest.models.find(candidate => candidate.profile === profileId);
  if (!model) throw new Error(`No generation profile named ${profileId} in formal/execution.json`);
  const descriptor = profiles[profileId];
  if (!descriptor || !descriptor.explicitInputs) throw new Error(`Profile ${profileId} has no explicit-input feature descriptor; the differential replays explicit inputs only`);
  return { ...model, manifest, descriptor };
}

// The complete differential for one profile. `reference` is a git revision
// whose text generates the reference corpus; the candidate is the working tree.
export async function runDifferential(profileId, { reference = 'origin/main', chunk = defaultChunk, output = defaultOutput,
    concurrency = resolveConcurrency(), cwd = root, log = console.log } = {}) {
  const manifest = readExecution();
  validateExecution(manifest);
  const model = differentialModel(manifest, profileId);
  const seed = manifest.settings.seed;
  const revision = resolveMergeBase(reference, { cwd });
  const outputDirectory = resolve(cwd, output, profileId);
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  const referenceTree = resolve(outputDirectory, 'reference');
  const candidateTree = resolve(outputDirectory, 'candidate');
  const referenceFiles = exportRevision(revision, referenceTree, { cwd });
  const candidateFiles = copySources(cwd, candidateTree);
  if (!existsSync(resolve(referenceTree, model.path))) throw new Error(`${model.path} does not exist at ${revision.slice(0, 12)}; a new profile has no reference corpus to replay`);
  const referenceText = readFileSync(resolve(referenceTree, model.path), 'utf8');
  const candidateText = readFileSync(resolve(cwd, model.path), 'utf8');
  log(`Corpus differential for ${profileId}: reference ${revision.slice(0, 12)} (${referenceFiles.length} sources), candidate working tree (${candidateFiles.length} sources), seed ${seed}.`);
  const corpusDirectory = model.generate.outputDirectory;
  const [referenceCorpus, candidateCorpus] = await Promise.all([
    generateCorpus(referenceTree, model, { seed, outputDirectory: corpusDirectory }),
    generateCorpus(candidateTree, model, { seed, outputDirectory: corpusDirectory }),
  ]);
  printGroup(`Reference generation (${seconds(referenceCorpus.generationMs)})`, referenceCorpus.log);
  printGroup(`Candidate generation (${seconds(candidateCorpus.generationMs)})`, candidateCorpus.log);
  const sampled = loadHistories(referenceCorpus.directory, model.descriptor);
  const regressions = loadHistories(referenceCorpus.regressions, model.descriptor);
  const histories = [...sampled, ...regressions.map(history => ({ ...history, path: `regression:${history.path}` }))];
  log(`Replaying ${sampled.length} sampled histories and ${regressions.length} exported regressions through the candidate in chunks of ${chunk}.`);
  const started = performance.now();
  const verdicts = await replayHistories(candidateTree, model, model.descriptor, histories, { chunk, seed, output: outputDirectory, concurrency });
  const replayMs = performance.now() - started;
  const disagreements = verdicts.filter(verdict => !verdict.agree);
  const referenceSize = bytesPerState(referenceCorpus.directory);
  const candidateSize = bytesPerState(candidateCorpus.directory);
  const report = {
    schemaVersion: 1, profile: profileId, model: model.path, seed, reference: { revision, sha256: sha256(referenceText) },
    candidate: { sha256: sha256(candidateText) }, identicalText: referenceText === candidateText,
    histories: { sampled: sampled.length, regressions: regressions.length, agreed: verdicts.length - disagreements.length, disagreed: disagreements.length },
    disagreements: disagreements.slice(0, 20),
    generation: { referenceMs: Math.round(referenceCorpus.generationMs), candidateMs: Math.round(candidateCorpus.generationMs),
      wallRatio: referenceCorpus.generationMs ? candidateCorpus.generationMs / referenceCorpus.generationMs : null,
      reference: referenceSize, candidate: candidateSize,
      bytesPerStateRatio: referenceSize.bytesPerState ? candidateSize.bytesPerState / referenceSize.bytesPerState : null },
    replay: { chunk, chunks: Math.ceil(histories.length / chunk), wallMs: Math.round(replayMs) },
  };
  writeFileSync(resolve(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

export function formatReport(report) {
  const lines = [
    `${report.profile}: ${report.histories.agreed} of ${report.histories.sampled + report.histories.regressions} histories agree` +
      ` (${report.histories.sampled} sampled, ${report.histories.regressions} regressions); replay ${seconds(report.replay.wallMs)} in ${report.replay.chunks} chunk(s).`,
    `generation wall ${seconds(report.generation.referenceMs)} -> ${seconds(report.generation.candidateMs)} (x${report.generation.wallRatio?.toFixed(2)}),` +
      ` bytes/state ${report.generation.reference.bytesPerState.toFixed(0)} -> ${report.generation.candidate.bytesPerState.toFixed(0)} (x${report.generation.bytesPerStateRatio?.toFixed(3)})` +
      (report.identicalText ? '; the texts are identical' : ''),
  ];
  for (const disagreement of report.disagreements) lines.push(`  ${disagreement.path}: ${disagreement.reason}`);
  if (report.histories.disagreed > report.disagreements.length) lines.push(`  ... ${report.histories.disagreed - report.disagreements.length} more`);
  return lines.join('\n');
}

const usage = `Usage: node formal/differential.mjs <profile> | --composed [--reference=<revision>] [--chunk=<n>] [--out=<directory>]

Generates <profile>'s corpus from the merge base with <revision> (default
origin/main) and from the working tree with the lane's command and seed, replays
every reference history and exported regression through the working tree's
text, and fails on any step whose driver-asserted observation differs. The
report (report.json under --out, default ${defaultOutput}/<profile>) records the
generation wall-time and bytes-per-state ratios. --composed runs every profile
whose text imports a kernel module; a profile the reference revision does not
generate yet (a new profile) is reported and skipped.`;

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
  const settings = { ...(typeof options.reference === 'string' ? { reference: options.reference } : {}),
    chunk, ...(typeof options.out === 'string' ? { output: options.out } : {}) };
  const selected = options.composed ? composedProfiles(readExecution()) : positional;
  if (!selected.length) { console.log('No composed profile imports a kernel module; nothing to replay.'); return 0; }
  let failed = false;
  for (const profileId of selected) {
    const report = await runDifferential(profileId, settings);
    console.log(formatReport(report));
    if (report.histories.disagreed) failed = true;
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof CommandFailure || error instanceof Error ? error.message : error);
    process.exitCode = typeof error?.status === 'number' && error.status > 0 ? error.status : 1;
  });
}
