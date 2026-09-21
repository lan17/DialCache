import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copySources, importClosure, quintSources, readExecution, reproducerCheckpoint, scheduleExecution, validateExecution } from './execution.mjs';
import { printGroup, resolveConcurrency, runPool, seconds, spawnBuffered } from './quint-pool.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export function validatePropertyResult(result, exitCode, expectation) {
  if (!['baseline', 'mutant'].includes(expectation)) throw new Error('Unknown model measurement expectation');
  if (!result || !Array.isArray(result.errors) || result.errors.length ||
      !Array.isArray(result.trace) || result.trace.length === 0) {
    throw new Error('Evaluator errors or incomplete traces are not property evidence');
  }
  if (expectation === 'baseline' && (exitCode !== 0 || result.status !== 'ok')) {
    throw new Error('Unmodified model must satisfy the property');
  }
  // An invariant can fail in the initial state; one state is a real witness.
  if (expectation === 'mutant' && (exitCode !== 1 || result.status !== 'violation')) {
    throw new Error('Compiling model fault survived or did not produce an invariant violation');
  }
}

// A reproducer is one named run plus two probes cut from it at the declared
// checkpoint, executed together with `quint test --match=^(run|probes)$`. The
// clean model must report all three passed. The mutant must exit 1 and report
// the run failed, the chain before the checkpoint passed and the chain through
// it failed because its expect did not hold: a compile error, a run the pattern
// never selected, a step the fault disables or a different expectation is not
// detection. `code` records the Quint error code of that checkpoint failure.
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXPECT_FAILED = 'Expect condition does not hold true';
export const probeNames = run => ({ before: `${run}BeforeCheckpointProbe`, through: `${run}ThroughCheckpointProbe` });
function testOutcome(output, name) {
  const escaped = escapeRegExp(name);
  const passed = new RegExp(`^\\s*ok ${escaped} passed \\d+ test\\(s\\)$`, 'm').test(output);
  const failed = new RegExp(`^\\s*\\d+\\) ${escaped} failed after \\d+ test\\(s\\)$`, 'm').test(output);
  if (passed === failed) return undefined;
  const error = failed ? new RegExp(`^\\s*\\d+\\) ${escaped}:\\s*\\n\\s*Error \\[(QNT\\d+)\\]: (.*)$`, 'm').exec(output) : undefined;
  return { passed, code: error?.[1], message: error?.[2]?.trim() };
}
export function validateReproducerResult(output, exitCode, run, expectation) {
  if (!['baseline', 'mutant'].includes(expectation)) throw new Error('Unknown model measurement expectation');
  if (typeof output !== 'string' || typeof run !== 'string' || !run) throw new Error('Reproducer output and run name are required');
  const names = probeNames(run);
  const results = { run: testOutcome(output, run), before: testOutcome(output, names.before), through: testOutcome(output, names.through) };
  for (const [part, result] of Object.entries(results)) {
    if (!result) throw new Error(`Reproducer ${run} did not run: the output names its ${part === 'run' ? 'run' : `${part}-checkpoint probe`} neither passed nor failed`);
  }
  if (expectation === 'baseline') {
    if (exitCode !== 0 || Object.values(results).some(result => !result.passed)) throw new Error(`Reproducer ${run} must pass on the unmodified model`);
    return { status: 'passed' };
  }
  if (exitCode === 0 || results.run.passed) throw new Error(`Reproducer ${run} passes under the fault: this history does not distinguish it`);
  if (exitCode !== 1) throw new Error(`Reproducer ${run} ended abnormally (exit ${exitCode}) instead of failing its own run`);
  const describe = result => `${result.code ?? 'no Quint error code'}${result.message ? ` ${result.message}` : ''}`;
  if (!results.before.passed) throw new Error(`Reproducer ${run} fails before its declared checkpoint: ${describe(results.before)}`);
  if (results.through.passed) throw new Error(`Reproducer ${run} holds at its declared checkpoint under the fault; a later step or expectation fails instead`);
  if (results.through.code !== 'QNT508' || results.through.message !== EXPECT_FAILED) {
    throw new Error(`Reproducer ${run} does not fail its declared expectation: ${describe(results.through)}`);
  }
  return { status: 'failed', code: results.through.code };
}

// Every scheduled run must have a terminal result. Only a failed expectation
// or a test returning false is assertion evidence. A named disabled/failed
// history is kept separately and never credited; it does not erase an
// independent assertion failure elsewhere in the same compiled profile.
export function validateProfileTests(output, exitCode, runs) {
  if (typeof output !== 'string' || !Array.isArray(runs) || new Set(runs).size !== runs.length) throw new Error('Invalid profile test measurement');
  const failed = [], inconclusive = [];
  for (const name of runs) {
    const result = testOutcome(output, name);
    if (!result) throw new Error(`Profile run ${name} did not complete`);
    if (result.passed) continue;
    if (!(result.code === 'QNT508' && result.message === EXPECT_FAILED) &&
        !(result.code === 'QNT511' && result.message === `Test ${name} returned false`)) {
      if (!result.code || !result.message) throw new Error(`Profile run ${name} failed without complete Quint diagnostics`);
      inconclusive.push({ run: name, code: result.code, message: result.message });
      continue;
    }
    failed.push(name);
  }
  if (exitCode !== (failed.length || inconclusive.length ? 1 : 0)) throw new Error('Profile test exit code and assertion results disagree');
  return { status: failed.length ? 'failed' : inconclusive.length ? 'inconclusive' : 'passed', failed,
    ...(inconclusive.length ? { inconclusive } : {}) };
}

// A library fault partitions every profile by the code it imports, not by
// prose in an exclusion. The cited profile already has a checked reproducer;
// a non-importing listed profile is an impossible claim, even in a partial run.
export function challengePartitionPlan(challenge, manifest, directory = root, closures) {
  if (!challenge.reproducer || !manifest.libraries.includes(challenge.source)) return [];
  const listed = new Set(challenge.reproducer.profiles);
  return manifest.models.filter(model => model.profile).map(model => {
    const reaches = (closures?.get(model.path) ?? importClosure(model.path, directory)).includes(challenge.source);
    if (listed.has(model.profile) && !reaches) throw new Error(`${challenge.id}/${model.profile}: listed profile does not import ${challenge.source}`);
    if (!listed.has(model.profile) && !Object.hasOwn(challenge.reproducer.exclusions, model.profile)) {
      throw new Error(`${challenge.id}/${model.profile}: profile is neither listed nor excluded`);
    }
    return { model, mode: listed.has(model.profile) ? 'listed' : reaches ? 'excluded' : 'structural' };
  });
}

// The callbacks share clean and mutated measurement caches in the real
// runner. Keeping this decision separate makes each exclusion and every
// baseline requirement testable without treating a process error as evidence.
export async function checkChallengePartition(challenge, plan, { tests, invariants, proven = new Set(), checkExclusions = false, onResult = () => {}, onInconclusive = () => {} }) {
  const partition = {};
  const record = (profile, state) => { partition[profile] = state; onResult(profile, state); };
  const baseline = (result, model) => {
    if (result.status !== 'passed') throw new Error(`${challenge.id}/${model.profile}: unmodified profile must pass before partition measurement`);
  };
  for (const { model, mode } of plan) {
    const profile = model.profile;
    if (mode === 'structural') { record(profile, 'structural'); continue; }
    if (mode === 'listed' && proven.has(model.path)) { record(profile, 'detects'); continue; }
    baseline(await tests(model, 'baseline'), model);
    const tested = await tests(model, 'mutant');
    if (tested.inconclusive?.length) onInconclusive(profile, tested.inconclusive);
    if (tested.status === 'failed') {
      if (mode === 'excluded') throw new Error(`exclusion no longer holds: ${challenge.id}/${profile}; list the profile in profiles (${tested.failed.join(', ')})`);
      record(profile, 'detects');
      continue;
    }
    if (mode === 'listed' || checkExclusions) {
      baseline(await invariants(model, 'baseline'), model);
      const checked = await invariants(model, 'mutant');
      if (mode === 'listed' && checked.status !== 'failed') throw new Error(`${challenge.id}/${profile}: listed profile does not detect the mutant in its runs or scheduled invariants`);
      if (mode === 'excluded' && checked.status !== 'passed') throw new Error(`exclusion no longer holds: ${challenge.id}/${profile}; list the profile in profiles (scheduled invariant violation)`);
    }
    if (mode === 'excluded' && tested.status !== 'passed') {
      throw new Error(`${challenge.id}/${profile}: exclusion is inconclusive because mutant histories failed without assertion evidence (${tested.inconclusive.map(item => `${item.run}: ${item.code} ${item.message}`).join('; ')})`);
    }
    record(profile, mode === 'listed' ? 'detects' : 'holds');
  }
  return partition;
}

// Select a subset of the catalog by id for local iteration. The complete
// catalog remains the only accepted evidence: a filtered report is never final.
export function selectChallenges(manifest, only) {
  if (only === undefined) return manifest.challenges;
  const ids = new Set(only.split(',').filter(Boolean));
  const selected = manifest.challenges.filter(challenge => ids.has(challenge.id));
  const missing = [...ids].filter(id => !selected.some(challenge => challenge.id === id));
  if (missing.length) throw new Error(`Unknown model property challenges: ${missing.join(', ')}`);
  return selected;
}

// Challenge workspaces are independent. Keep their original errors and the
// partial evidence in catalog order, but finish the other measurements before
// failing the campaign so one stale partition cannot hide the next one.
export async function runChallengeMeasurements(report, measure, { concurrency = resolveConcurrency(), save = () => {} } = {}) {
  report.complete = false;
  const results = await runPool(report.challenges.map((entry, index) => async () => {
    try {
      await measure(entry, index);
    } catch (error) {
      entry.error = String(error);
      return { entry, error };
    } finally { save(); }
  }), { concurrency });
  const failures = results.filter(result => result !== undefined);
  if (failures.length) {
    throw new AggregateError(failures.map(failure => failure.error),
      `Model property measurements failed for ${failures.length} challenge(s):\n${failures.map(({ entry }) => `${entry.id}: ${entry.error}`).join('\n')}`);
  }
  report.complete = !report.partial;
  try { save(); }
  catch (error) { report.complete = false; throw error; }
}

export async function measureModelProperties({ only, concurrency = resolveConcurrency() } = {}) {
  const output = resolve(root, '.formal-traces/model-properties');
  const manifest = readExecution();
  // A complete measurement validates the whole manifest first; a filtered run
  // is a local iteration aid and may precede catalog coverage.
  if (only === undefined) validateExecution(manifest);
  const scheduled = scheduleExecution(manifest);
  const profileClosures = new Map(scheduled.models.filter(model => model.profile).map(model => [model.path, importClosure(model.path)]));
  const challenges = selectChallenges(manifest, only);
  const { settings, check } = manifest;
  const options = [`--backend=${settings.backend}`, `--n-threads=${settings.threads}`, `--seed=${settings.seed}`,
    `--max-samples=${check.maxSamples}`, `--max-steps=${check.maxSteps}`];
  const sources = new Map(quintSources().map(path => [path, readFileSync(resolve(root, path), 'utf8')]));
  mkdirSync(output, { recursive: true });
  const report = { schemaVersion: 5, complete: false, partial: only !== undefined, mode: 'bounded-simulation', options,
    sources: Object.fromEntries([...sources].map(([path, source]) => [path, createHash('sha256').update(source).digest('hex')])),
    catalogSha256: createHash('sha256').update(readFileSync(resolve(root, 'formal/execution.json'))).digest('hex'),
    catalog: manifest.challenges.length, reproducers: manifest.challenges.filter(challenge => challenge.reproducer).length,
    reproducerBacklog: manifest.reproducerBacklog.length, nativeMutantBacklog: manifest.nativeMutantBacklog.length,
    partitionMeasurements: { executed: 0, cacheHits: 0, commandSeconds: 0 }, challenges: [] };
  const save = () => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  save();
  async function execute(args) {
    // Bounds a hung evaluator, not a slow runner: a single bounded run took up
    // to 35 s on the slow hosted runner of run 34666226055 before this pool
    // shared its cores with three siblings.
    const result = await spawnBuffered('quint', args, { cwd: root, timeoutMs: 180_000 });
    if (result.error || result.signal) throw new Error(`Quint execution failed (${args.slice(0, 2).join(' ')}): ${result.error ?? result.signal}`);
    return result;
  }
  const partitionCache = new Map(), compileCache = new Map();
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  // Cache only exact source closures and exact evaluator options. A shared
  // library fault can have several challenge ids, but identical names or
  // native-mutant ids alone are never enough to share evidence.
  async function profileMeasurement(kind, model, label, challenge, workspace) {
    const source = sources.get(challenge.source);
    writeFileSync(resolve(workspace, challenge.source), label === 'baseline' ? source : source.replace(challenge.before, () => challenge.after));
    const closure = importClosure(model.path, workspace).map(path => [path, readFileSync(resolve(workspace, path), 'utf8')]);
    const compileKey = hash({ model: model.path, closure });
    const selected = kind === 'tests' ? model.regressions : model.invariants;
    const flags = kind === 'tests' ? [`--backend=${settings.backend}`, '--max-samples=1', `--seed=${settings.seed}`] : options;
    const key = hash({ compileKey, kind, selected, flags });
    if (partitionCache.has(key)) {
      report.partitionMeasurements.cacheHits++;
      return partitionCache.get(key);
    }
    const pending = (async () => {
      report.partitionMeasurements.executed++;
      const modelPath = resolve(workspace, model.path);
      const prefix = resolve(output, `partition-${model.profile}-${key}`);
      if (!compileCache.has(compileKey)) {
        compileCache.set(compileKey, (async () => {
          const compile = await execute(['typecheck', modelPath]);
          writeFileSync(resolve(output, `partition-${model.profile}-${compileKey}-typecheck.log`), compile.stdout + compile.stderr);
          report.partitionMeasurements.commandSeconds += compile.durationMs / 1000;
          if (compile.status !== 0) throw new Error(`${challenge.id}/${model.profile}/${label}: profile must typecheck before partition measurement`);
        })());
      }
      await compileCache.get(compileKey);
      if (kind === 'tests' && selected.length === 0) return { status: 'passed', failed: [] };
      if (!selected.length) throw new Error(`${challenge.id}/${model.profile}: no scheduled invariants for partition measurement`);
      const args = kind === 'tests'
        ? ['test', modelPath, ...flags]
        : ['run', modelPath, ...flags, '--invariants', ...selected, `--out=${prefix}.json`];
      rmSync(`${prefix}.json`, { force: true });
      const evaluated = await execute(args);
      const detail = evaluated.stdout + evaluated.stderr;
      writeFileSync(`${prefix}.log`, detail);
      report.partitionMeasurements.commandSeconds += evaluated.durationMs / 1000;
      save();
      if (kind === 'tests') return validateProfileTests(detail, evaluated.status, selected);
      const result = JSON.parse(readFileSync(`${prefix}.json`, 'utf8'));
      validatePropertyResult(result, evaluated.status, result.status === 'violation' ? 'mutant' : 'baseline');
      return { status: result.status === 'violation' ? 'failed' : 'passed' };
    })();
    partitionCache.set(key, pending);
    return pending;
  }
  // Each challenge measures in its own copy of every Quint source, so challenges
  // run side by side and no mutation can leak into another baseline. The report
  // fingerprints every Quint dependency. Both runs of a challenge share the copy
  // and restore the unmodified sources first.
  async function measure(challenge, entry) {
    const source = sources.get(challenge.source);
    const workspace = mkdtempSync(resolve(tmpdir(), 'dialcache-model-properties-'));
    const lines = [];
    let detail = '';
    try {
      for (const label of ['baseline', 'mutant']) {
        copySources(root, workspace);
        if (label === 'mutant') writeFileSync(resolve(workspace, challenge.source), source.replace(challenge.before, () => challenge.after));
        const model = resolve(workspace, challenge.model);
        const prefix = resolve(output, `${challenge.id}-${label}`);
        const compile = await execute(['typecheck', model]);
        detail = compile.stdout + compile.stderr;
        writeFileSync(`${prefix}-typecheck.log`, detail);
        if (compile.status !== 0) throw new Error(`${challenge.id}/${label}: model must typecheck before measurement`);
        rmSync(`${prefix}.json`, { force: true });
        const run = await execute(['run', model, ...options, '--invariants', challenge.invariant, `--out=${prefix}.json`]);
        detail = run.stdout + run.stderr;
        writeFileSync(`${prefix}.log`, detail);
        const result = JSON.parse(readFileSync(`${prefix}.json`, 'utf8'));
        validatePropertyResult(result, run.status, label);
        entry[label] = label === 'baseline' ? 'passed' : 'detected';
        if (label === 'mutant') entry.counterexampleStates = result.trace.length;
        save();
        lines.push(`${label}: typecheck ${seconds(compile.durationMs)}; run ${result.status} after ${result.trace.length} states, ${seconds(run.durationMs)}\n`);
        if (challenge.reproducer === undefined) continue;
        // The reproducer replays one named history in the same copy of the
        // sources, with two probes cut from the run at its declared checkpoint
        // appended to the cited model: all three pass here on the baseline; on
        // the mutant the run and the probe through the checkpoint fail while
        // the probe before it still passes.
        const { run: name, failure } = challenge.reproducer;
        const cited = resolve(workspace, challenge.reproducer.model ?? challenge.model);
        const text = readFileSync(cited, 'utf8');
        const checkpoint = reproducerCheckpoint(text, name, failure);
        const names = probeNames(name);
        const end = text.lastIndexOf('}');
        writeFileSync(cited, `${text.slice(0, end)}  run ${names.before} = ${checkpoint.before}\n  run ${names.through} = ${checkpoint.through}\n${text.slice(end)}`);
        let test;
        try {
          test = await execute(['test', cited, `--backend=${settings.backend}`, '--max-samples=1',
            `--seed=${settings.seed}`, `--match=^(${name}|${names.before}|${names.through})$`]);
        } finally {
          // Partition runs measure the declared profile, without the temporary
          // checkpoint probes, and can share the same clean source fingerprint.
          writeFileSync(cited, text);
        }
        detail = test.stdout + test.stderr;
        writeFileSync(`${prefix}-reproducer.log`, detail);
        const outcome = validateReproducerResult(detail, test.status, name, label);
        entry.reproducer[label] = outcome.status;
        if (label === 'mutant') entry.reproducer.code = outcome.code;
        save();
        lines.push(`${label}: reproducer ${name} ${outcome.status}${outcome.code ? ` (${outcome.code} at the declared checkpoint)` : ''}, ${seconds(test.durationMs)}\n`);
        if (label === 'mutant') {
          const plan = challengePartitionPlan(challenge, scheduled, root, profileClosures);
          if (plan.length) {
            const started = performance.now();
            // The cited run and the primary invariant already have clean and
            // mutant evidence in this workspace; use those exact checks once.
            const primary = scheduled.models.find(model => model.path === challenge.model);
            const proven = new Set([challenge.reproducer.model ?? challenge.model]);
            if (primary?.invariants.includes(challenge.invariant)) proven.add(challenge.model);
            entry.partition = {};
            await checkChallengePartition(challenge, plan, {
              proven, checkExclusions: only !== undefined,
              onResult: (profile, state) => { entry.partition[profile] = state; },
              onInconclusive: (profile, histories) => { (entry.partitionInconclusive ??= {})[profile] = histories; },
              tests: (model, label) => profileMeasurement('tests', model, label, challenge, workspace),
              invariants: (model, label) => profileMeasurement('invariants', model, label, challenge, workspace),
            });
            entry.partitionSeconds = Math.round((performance.now() - started) / 1000);
            const counts = ['structural', 'holds', 'detects'].map(state => `${state}=${Object.values(entry.partition).filter(value => value === state).length}`);
            lines.push(`partition: ${counts.join(', ')}, ${entry.partitionSeconds} s\n`);
            save();
          }
        }
      }
      printGroup(`${challenge.id}: compiling fault violates ${challenge.invariant}`, ...lines);
    } catch (error) {
      printGroup(`${challenge.id}: measurement failed`, ...lines, detail, `${error}\n`);
      throw error;
    } finally { rmSync(workspace, { recursive: true, force: true }); }
  }
  try {
    const version = await execute(['--version']);
    if (version.status !== 0) throw new Error('Cannot read Quint version');
    report.quintVersion = version.stdout.trim();
    for (const challenge of challenges) {
      const source = sources.get(challenge.source);
      if (source === undefined || source.split(challenge.before).length !== 2) {
        throw new Error(`${challenge.id}: mutation anchor must match exactly once`);
      }
    }
    // Entries hold catalog order from the start; completions fill them in place,
    // so the saved report never depends on which challenge finished first.
    for (const challenge of challenges) {
      report.challenges.push({ ...challenge, baseline: 'pending', mutant: 'pending',
        ...(challenge.reproducer === undefined ? {} : { reproducer: { ...challenge.reproducer, baseline: 'pending', mutant: 'pending' } }) });
    }
    save();
    await runChallengeMeasurements(report, (entry, index) => measure(challenges[index], entry), { concurrency, save });
    return report;
  } catch (error) {
    report.complete = false;
    report.error = String(error);
    save();
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [option, ...extra] = process.argv.slice(2);
  if (extra.length || (option !== undefined && !option.startsWith('--only='))) throw new Error('Usage: node formal/check-model-properties.mjs [--only=id,id]');
  await measureModelProperties({ only: option?.slice('--only='.length) });
}
