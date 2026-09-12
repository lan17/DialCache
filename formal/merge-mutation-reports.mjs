import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fingerprintFiles, gateDetections, languages, sha256 } from './mutation-reports.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

// Fields a shard legitimately owns or that the merge recomputes. Every other
// field describes the measured inputs and must be identical across shards.
const perShardFields = new Set(['complete', 'shard', 'startedAt', 'elapsedSeconds', 'baselines', 'mutations', 'error', 'detection', 'requiredDetectionRegressions', 'shards']);
const timingFields = new Set(['startedAt', 'finishedAt', 'elapsedSeconds', 'durationMs', 'duration']);

// Stable text for structural comparison: key order is irrelevant, timing is dropped.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter(key => !timingFields.has(key)).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

// Go records the executed leaf tests in completion order, which parallel
// subtests may permute between runners; the single-process runner already
// compares that list as a set.
function comparableBaseline(result) {
  if (!result || typeof result !== 'object') return result;
  return Array.isArray(result.executedTests) ? { ...result, executedTests: [...result.executedTests].sort() } : result;
}

const describe = report => `${report.shard.index}/${report.shard.count}`;

// Pure merge over parsed shard reports. `catalog` and `catalogSha256` come
// from the checkout the merge runs in; `inputs` is that checkout's fingerprint
// over the language's measured paths. The caller then runs gateDetections.
export function mergeShardReports(language, shards, { catalog, catalogSha256, inputs }) {
  const refuse = message => { throw new Error(`${language.name} mutation shards cannot be merged: ${message}`); };
  if (!Array.isArray(shards) || !shards.length) refuse('no shard reports were found');
  for (const report of shards) {
    const shard = report?.shard;
    if (!shard || !Number.isSafeInteger(shard.index) || !Number.isSafeInteger(shard.count) || shard.index < 1 || shard.index > shard.count) refuse('a report has no valid shard descriptor { index, count }');
    if (report.schemaVersion !== 1) refuse(`shard ${describe(report)} has schemaVersion ${report.schemaVersion}`);
    if (report.complete !== false) refuse(`shard ${describe(report)} claims complete=${JSON.stringify(report.complete)}; only the merged report is complete evidence`);
    if ('error' in report) refuse(`shard ${describe(report)} failed: ${report.error}`);
    if (!Array.isArray(shard.mutationIds) || !Array.isArray(report.mutations) || !report.baselines || typeof report.baselines !== 'object') refuse(`shard ${describe(report)} lacks its mutation list, baselines or mutation results`);
  }
  const counts = [...new Set(shards.map(report => report.shard.count))];
  if (counts.length !== 1) refuse(`shard counts disagree: ${counts.join(', ')}`);
  const [count] = counts;
  const indexes = shards.map(report => report.shard.index).sort((a, b) => a - b);
  const duplicates = indexes.filter((index, position) => indexes[position - 1] === index);
  if (duplicates.length) refuse(`shard ${[...new Set(duplicates)].join(', ')} of ${count} appears more than once`);
  const missing = Array.from({ length: count }, (_, position) => position + 1).filter(index => !indexes.includes(index));
  if (missing.length) refuse(`shard ${missing.join(', ')} of ${count} is missing`);
  const ordered = [...shards].sort((a, b) => a.shard.index - b.shard.index);
  const [first] = ordered;
  if (first.catalogSha256 !== catalogSha256) refuse(`catalogSha256 ${first.catalogSha256} was measured, but this checkout's ${language.catalog} hashes to ${catalogSha256}`);
  if (inputs !== undefined && canonical(first.inputs) !== canonical(inputs)) refuse(`inputs fingerprint ${first.inputs?.sha256} was measured, but this checkout's ${language.inputs.join('/')} hash to ${inputs.sha256}`);
  for (const report of ordered.slice(1)) {
    const fields = [...new Set([...Object.keys(first), ...Object.keys(report)])].filter(key => !perShardFields.has(key)).sort();
    for (const field of fields) if (canonical(first[field]) !== canonical(report[field])) refuse(`${field} differs between shards 1 and ${report.shard.index}`);
    const cohorts = [...new Set([...Object.keys(first.baselines), ...Object.keys(report.baselines)])].sort();
    for (const cohort of cohorts) {
      if (canonical(comparableBaseline(first.baselines[cohort])) !== canonical(comparableBaseline(report.baselines[cohort]))) refuse(`baseline ${cohort} differs between shards 1 and ${report.shard.index}; every shard must measure the same unmodified suite`);
    }
  }
  // Each shard measured exactly what it declares, no mutation twice, and the
  // shards in index order cover the catalog in catalog order.
  const owner = new Map();
  for (const report of ordered) {
    const declared = report.shard.mutationIds, measured = report.mutations.map(mutation => mutation.id);
    if (declared.join(',') !== measured.join(',')) refuse(`shard ${describe(report)} declares [${declared.join(', ')}] but measured [${measured.join(', ')}]`);
    for (const id of measured) {
      if (owner.has(id)) refuse(`${id} appears in shards ${owner.get(id)} and ${report.shard.index}`);
      owner.set(id, report.shard.index);
    }
  }
  const mutations = ordered.flatMap(report => report.mutations);
  const expected = catalog.mutations.map(mutation => mutation.id);
  if (mutations.map(mutation => mutation.id).join(',') !== expected.join(',')) refuse(`the shards cover [${mutations.map(mutation => mutation.id).join(', ')}] but the catalog in order is [${expected.join(', ')}]`);
  const merged = { ...first };
  delete merged.shard;
  delete merged.requiredDetectionRegressions;
  merged.startedAt = ordered.map(report => report.startedAt).sort()[0];
  merged.mutations = mutations;
  // Total measurement time across shards, comparable to a single run's wall time.
  merged.elapsedSeconds = ordered.reduce((sum, report) => sum + (report.elapsedSeconds ?? 0), 0);
  merged.shards = ordered.map(report => ({ index: report.shard.index, count, mutationIds: report.shard.mutationIds, startedAt: report.startedAt, elapsedSeconds: report.elapsedSeconds }));
  return merged;
}

// Reads `<index>-of-<count>/report.json` under the shard directory. Other
// entries are ignored; a matching directory without a report is a shard that
// produced no evidence.
export function readShardReports(directory) {
  if (!existsSync(directory)) throw new Error(`no shard directory at ${directory}`);
  const reports = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = /^([1-9]\d*)-of-([1-9]\d*)$/.exec(entry.name);
    if (!match || !entry.isDirectory()) continue;
    const path = resolve(directory, entry.name, 'report.json');
    if (!existsSync(path)) throw new Error(`${entry.name} has no report.json`);
    let report;
    try { report = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(`${entry.name}/report.json is not valid JSON: ${error.message}`); }
    if (report?.shard?.index !== Number(match[1]) || report?.shard?.count !== Number(match[2])) throw new Error(`${entry.name}/report.json describes shard ${report?.shard?.index}/${report?.shard?.count}`);
    reports.push(report);
  }
  return reports;
}

// Writes the complete report exactly where the single-process run writes it.
// Any refusal leaves an incomplete report with the reason in its place.
export function mergeMutationReports(name, { directory = root, shardsDirectory, outputDirectory } = {}) {
  const language = languages[name];
  if (!language) throw new Error(`Expected language ts or go; got ${name}`);
  const output = resolve(directory, outputDirectory ?? language.output);
  const shards = resolve(directory, shardsDirectory ?? resolve(output, 'shards'));
  const startedAt = new Date().toISOString();
  mkdirSync(output, { recursive: true });
  const save = report => writeFileSync(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  save({ schemaVersion: 1, complete: false, startedAt });
  rmSync(resolve(output, 'report.md'), { force: true });
  let merged;
  try {
    const catalogText = readFileSync(resolve(directory, language.catalog));
    const catalog = JSON.parse(catalogText);
    merged = mergeShardReports(language, readShardReports(shards), { catalog, catalogSha256: sha256(catalogText), inputs: fingerprintFiles(directory, language.inputs) });
    gateDetections(language, merged, catalog.mutations, { directory });
  } catch (error) {
    const failed = merged ?? { schemaVersion: 1, complete: false, startedAt };
    failed.complete = false;
    failed.error = String(error);
    save(failed);
    throw error;
  }
  save(merged);
  writeFileSync(resolve(output, 'report.md'), language.markdown(merged));
  return merged;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [name, shardsDirectory, ...extra] = process.argv.slice(2);
  if (!languages[name] || extra.length) {
    console.error('Usage: node formal/merge-mutation-reports.mjs <ts|go> [shard-directory]');
    process.exitCode = 2;
  } else {
    try {
      const report = mergeMutationReports(name, { shardsDirectory });
      const summary = name === 'ts' ? report.detection.all : report.detection;
      console.log(`Merged ${report.shards.length} ${languages[name].name} shards: ${report.mutations.length} mutations, ${Object.entries(summary).map(([cohort, score]) => `${cohort}=${score.detected}/${score.total}`).join(', ')}`);
      console.log(`Report: ${languages[name].output}/report.md`);
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
