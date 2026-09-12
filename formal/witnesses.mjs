import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readExecution, root } from './execution.mjs';
import { witnessEvidence, writeWitnessEvidence } from './replay/witnesses/evidence.mjs';
import { checkWitnesses, readWitnessRegistry, witnessProfiles } from './replay/witnesses/index.mjs';

// Language-neutral witness completion. Any port runs this over the generated
// corpus instead of TypeScript's test suite: it evaluates the shared
// classifiers, requires every registered witness and declared action, and
// writes the evidence consumed by Go (and any other port) under
// .formal-traces/go-parity-witnesses. Failing profiles write nothing and
// remove stale evidence so a later consumer cannot reuse an older pass.
//
// Every run also prints the fragility report (which required labels few or no
// sampled histories reach, and how diverse the sampled histories are) and,
// when formal/witness-baseline.json records the pinned corpus, compares each
// required label's sampled hits with that baseline. evaluate fails when a
// gated label drops below the tolerance; report only prints; baseline --write
// records the current corpus as the baseline.
const tracesPrefix = '.formal-traces/';
const commands = ['evaluate', 'report', 'baseline'];
const usage = ['Usage: node formal/witnesses.mjs evaluate [--profile <name|all>] [--traces <dir>] [--out <dir>] [--baseline <path>]',
  '       node formal/witnesses.mjs report [--profile <name|all>] [--traces <dir>] [--baseline <path>]',
  '       node formal/witnesses.mjs baseline --write [--profile <name|all>] [--traces <dir>] [--baseline <path>]'].join('\n');
export const defaultBaselinePath = 'formal/witness-baseline.json';
export const reportFileName = 'witness-report.json';
// A required label reached by this many sampled histories or fewer is rare.
export const rareMaximum = 3;
export const baselineDefaults = { tolerance: 0.5, gatedMinimum: 10 };

export function parseArguments(args) {
  const [command, ...rest] = args;
  if (!commands.includes(command)) throw new Error(usage);
  const options = { command, profile: 'all', traces: '.formal-traces', out: '.formal-traces/go-parity-witnesses', baseline: defaultBaselinePath, write: false };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === '--write' && command === 'baseline') { options.write = true; continue; }
    const key = typeof argument === 'string' && argument.startsWith('--') ? argument.slice(2) : undefined, value = rest[index + 1];
    if (!['profile', 'traces', 'out', 'baseline'].includes(key) || value === undefined || (key === 'out' && command !== 'evaluate')) throw new Error(usage);
    options[key] = value;
    index += 1;
  }
  if (command === 'baseline' && !options.write) throw new Error(usage);
  return options;
}

// Sampled histories come from the profile's generate.outputDirectory; exported
// public-action regressions from .formal-traces/regressions/<profile>. Both
// are relocated under --traces so an alternate corpus can be evaluated. The
// directory a history came from decides its kind in the evidence.
export function traceKind(path, directories) {
  const directory = dirname(resolve(path));
  if (directory === resolve(directories.sampled)) return 'sampled';
  if (directory === resolve(directories.regressions)) return 'regression';
  throw new Error(`${path}: outside the sampled and regression corpus directories`);
}

export function witnessCorpus(profile, tracesRoot, execution = readExecution(), directory = root) {
  const model = execution.models.find(candidate => candidate.profile === profile);
  if (model === undefined) throw new Error(`${profile}: no scheduled model in formal/execution.json`);
  const output = model.generate?.outputDirectory;
  if (typeof output !== 'string' || !output.startsWith(tracesPrefix)) throw new Error(`${profile}: unsupported generate.outputDirectory`);
  const base = resolve(directory, tracesRoot);
  const directories = { sampled: resolve(base, output.slice(tracesPrefix.length)), regressions: resolve(base, 'regressions', profile) };
  if (!existsSync(directories.sampled)) throw new Error(`${profile}: missing sampled histories in ${directories.sampled}; run node formal/run-models.mjs generate first`);
  const paths = readdirSync(directories.sampled).filter(name => name.endsWith('.itf.json')).sort().map(name => resolve(directories.sampled, name));
  for (const regression of model.replayRegressions ?? []) paths.push(resolve(directories.regressions, `${regression}.itf.json`));
  const missing = paths.filter(path => !existsSync(path));
  if (missing.length) throw new Error(`${profile}: missing histories ${missing.map(path => relative(directory, path)).join(', ')}`);
  const kinds = new Map(paths.map(path => [basename(path), traceKind(path, directories)]));
  if (kinds.size !== paths.length) throw new Error(`${profile}: a sampled history and a regression share a file name`);
  return { paths, kinds, directories };
}

export function witnessCorpusPaths(profile, tracesRoot, execution = readExecution(), directory = root) {
  return witnessCorpus(profile, tracesRoot, execution, directory).paths;
}

export function selectedProfiles(selection, execution = readExecution()) {
  const scheduled = execution.models.map(model => model.profile).filter(profile => witnessProfiles.includes(profile));
  if (selection === 'all') return scheduled;
  if (!scheduled.includes(selection)) throw new Error(`Unknown witness profile ${selection}; expected one of ${scheduled.join(', ')} or all`);
  return [selection];
}

// The baseline records, per profile and required label, how many sampled
// histories of the pinned corpus reached the label, with the seed and a
// fingerprint of that sampled corpus.
export function readBaseline(path) {
  if (!existsSync(path)) return undefined;
  const baseline = JSON.parse(readFileSync(path, 'utf8'));
  if (baseline?.schemaVersion !== 1 || typeof baseline.seed !== 'string' || !(baseline.tolerance > 0 && baseline.tolerance < 1)
    || !Number.isInteger(baseline.gatedMinimum) || baseline.gatedMinimum < 1 || typeof baseline.profiles !== 'object' || baseline.profiles === null) {
    throw new Error(`${path}: unsupported witness baseline`);
  }
  return baseline;
}

export function sampledCorpusFingerprint(evidence, kinds) {
  const sampled = evidence.corpus.filter(({ name }) => kinds.get(name) === 'sampled');
  return createHash('sha256').update(sampled.map(({ name, sha256 }) => `${name} ${sha256}\n`).join('')).digest('hex');
}

export function recordBaseline(existing, entries, seed, defaults = baselineDefaults) {
  if (existing !== undefined && existing.seed !== seed) {
    throw new Error(`Recorded baseline seed ${existing.seed} differs from ${seed}; rewrite every profile with --profile all`);
  }
  const baseline = existing ?? { schemaVersion: 1, seed, ...defaults, profiles: {} };
  for (const { profile, evidence, kinds } of entries) {
    baseline.profiles[profile] = { sampledHistories: evidence.diversity.sampledHistories, corpusSha256: sampledCorpusFingerprint(evidence, kinds),
      labels: Object.fromEntries(evidence.required.map(label => [label, evidence.labels[label]?.sampled ?? 0])) };
  }
  baseline.profiles = Object.fromEntries(Object.entries(baseline.profiles).sort(([a], [b]) => a.localeCompare(b, 'en')));
  return baseline;
}

// The gate: a required label whose recorded sampled count is at least
// gatedMinimum fails when the fresh sampled count drops below tolerance times
// the recorded count. Labels recorded below the minimum, or not recorded, are
// reported and never gated.
export function baselineFindings(profile, rows, baseline) {
  const recorded = baseline?.profiles[profile];
  const findings = { recorded: recorded !== undefined, gated: [], failed: [], ungated: [], unrecorded: [] };
  for (const { label, sampled } of rows) {
    const base = recorded?.labels[label];
    if (base === undefined) { findings.unrecorded.push(label); continue; }
    if (base < baseline.gatedMinimum) { findings.ungated.push(label); continue; }
    findings.gated.push(label);
    const minimum = base * baseline.tolerance;
    if (sampled < minimum) findings.failed.push({ label, baseline: base, sampled, minimum });
  }
  return findings;
}

export function profileReport(profile, evidence, missing, kinds, baseline) {
  const rows = evidence.required.map(label => ({ label, sampled: evidence.labels[label]?.sampled ?? 0, regression: evidence.labels[label]?.regression ?? 0 }));
  const recorded = baseline?.profiles[profile];
  return { profile, histories: evidence.traces, diversity: evidence.diversity, missing,
    fragile: rows.filter(row => row.sampled <= rareMaximum && row.regression === 0),
    rare: rows.filter(row => row.sampled <= rareMaximum && row.regression >= 1),
    sameCorpusAsBaseline: recorded === undefined ? null : recorded.corpusSha256 === sampledCorpusFingerprint(evidence, kinds),
    baseline: baselineFindings(profile, rows, baseline) };
}

const percent = value => `${Math.round(value * 100)}%`;
const hits = row => `${row.label} (${row.sampled} sampled, ${row.regression} regression)`;

export function formatReport(report) {
  const lines = [];
  for (const summary of Object.values(report.profiles)) {
    const { diversity, baseline } = summary;
    lines.push(`witness/${summary.profile}: ${diversity.sampledHistories} sampled + ${summary.histories - diversity.sampledHistories} regression histories;`
      + ` ${diversity.distinctActionSequences} distinct action sequences, ${diversity.distinctObservationSequences} distinct observation sequences (sampled)`);
    if (summary.missing.length) lines.push(`  missing: ${summary.missing.join(', ')}`);
    lines.push(`  fragile, unpinned (sampled <= ${rareMaximum}, no regression): ${summary.fragile.length ? summary.fragile.map(hits).join(', ') : 'none'}`);
    lines.push(`  pinned but rare (sampled <= ${rareMaximum}, regression >= 1): ${summary.rare.length ? summary.rare.map(hits).join(', ') : 'none'}`);
    if (!baseline.recorded) { lines.push('  baseline: none recorded for this profile'); continue; }
    lines.push(`  baseline ${report.baseline.seed} (${summary.sameCorpusAsBaseline ? 'same' : 'different'} sampled corpus): ${baseline.gated.length} labels gated at ${percent(report.baseline.tolerance)},`
      + ` ${baseline.ungated.length} below the gated minimum of ${report.baseline.gatedMinimum}, ${baseline.unrecorded.length} unrecorded`);
    for (const failure of baseline.failed) lines.push(`  FAILED ${failure.label}: ${failure.sampled} sampled, minimum ${failure.minimum} (baseline ${failure.baseline})`);
  }
  return lines.join('\n');
}

export function evaluateProfiles(options, { directory = root, log = message => console.log(message) } = {}) {
  const execution = readExecution();
  const registry = readWitnessRegistry(resolve(directory, 'formal/coverage-witnesses.json'));
  const outputDirectory = resolve(directory, options.out);
  const baselinePath = resolve(directory, options.baseline);
  const baseline = readBaseline(baselinePath);
  const report = { schemaVersion: 1, command: options.command, traces: options.traces,
    baseline: baseline === undefined ? null : { path: options.baseline, seed: baseline.seed, tolerance: baseline.tolerance, gatedMinimum: baseline.gatedMinimum },
    profiles: {}, incomplete: [], failed: [] };
  const entries = [];
  for (const profile of selectedProfiles(options.profile, execution)) {
    const corpus = witnessCorpus(profile, options.traces, execution, directory);
    const check = checkWitnesses(profile, corpus.paths, registry);
    const evidence = witnessEvidence(profile, check, corpus, directory);
    const summary = profileReport(profile, evidence, check.missing, corpus.kinds, baseline);
    report.profiles[profile] = summary;
    entries.push({ profile, evidence, kinds: corpus.kinds });
    if (check.missing.length) {
      if (options.command === 'evaluate') rmSync(resolve(outputDirectory, `${profile}.json`), { force: true });
      report.incomplete.push(`witness/${profile}: ${check.traces} histories reached ${check.seen.size} labels; missing ${check.missing.join(', ')}`);
    } else if (options.command === 'evaluate') {
      const written = writeWitnessEvidence(outputDirectory, evidence);
      log(`witness/${profile}: ${check.traces} histories, ${check.seen.size} labels, ${check.required.length} required -> ${relative(directory, written)}`);
    }
    for (const failure of summary.baseline.failed) {
      report.failed.push(`witness/${profile}: ${failure.label} reached by ${failure.sampled} sampled histories, minimum ${failure.minimum} (baseline ${failure.baseline})`);
    }
  }
  if (options.command === 'baseline') {
    if (report.incomplete.length) throw new Error(`A baseline needs complete witness coverage:\n${report.incomplete.join('\n')}`);
    const seed = process.env.QUINT_SEED || execution.settings.seed;
    const written = recordBaseline(options.profile === 'all' ? undefined : baseline, entries, seed);
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, JSON.stringify(written, null, 2) + '\n');
    log(`Recorded sampled witness counts for ${entries.length} profile(s) at seed ${seed} -> ${relative(directory, baselinePath)}`);
    return report;
  }
  log(formatReport(report));
  const reportPath = resolve(directory, options.traces, reportFileName);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (options.command === 'evaluate') {
    const problems = [];
    if (report.incomplete.length) problems.push(`Incomplete witness coverage:\n${report.incomplete.join('\n')}`);
    if (report.failed.length) {
      problems.push(`Sampled witness hits fell below ${percent(baseline.tolerance)} of ${options.baseline} (seed ${baseline.seed}):\n${report.failed.join('\n')}`);
    }
    if (problems.length) throw new Error(problems.join('\n'));
  }
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { evaluateProfiles(parseArguments(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
