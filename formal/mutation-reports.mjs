import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared by measure-semantics.mjs, measure-go-semantics.mjs and
// merge-mutation-reports.mjs: the shard partition, the input fingerprint, the
// detection summary and the required-detection gate. One implementation keeps
// a merged report exactly as strict as a single-process one.
const root = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// --shard=<index>/<count> is 1-based; the default 1/1 is the complete
// single-process measurement.
export function parseShard(value) {
  if (value === undefined) return { index: 1, count: 1 };
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error(`Expected <index>/<count> with 1 <= index <= count; got ${JSON.stringify(value)}`);
  return { index: Number(match[1]), count: Number(match[2]) };
}

export function shardFromArguments(argv) {
  let value;
  for (const argument of argv) {
    if (!argument.startsWith('--shard=') || value !== undefined) throw new Error(`Usage: --shard=<index>/<count>; unexpected argument ${argument}`);
    value = argument.slice('--shard='.length);
  }
  return parseShard(value);
}

// A contiguous slice of the catalog in catalog order; the first
// (mutations mod count) shards take one mutation more. A shard beyond the
// catalog is empty and still measures its baselines.
export function partitionMutations(mutations, { index, count }) {
  const base = Math.floor(mutations.length / count), extra = mutations.length % count;
  const start = (index - 1) * base + Math.min(index - 1, extra);
  return mutations.slice(start, start + base + (index <= extra ? 1 : 0));
}

// Shards from separate jobs land in one tree without colliding; the single
// run keeps today's location.
export function shardDirectory(output, shard) {
  return shard.count === 1 ? output : resolve(output, 'shards', `${shard.index}-of-${shard.count}`);
}

// Hash the reviewed inputs, including uncommitted edits and exact file bytes.
// Git revision alone cannot identify an exploratory run from a dirty worktree.
export function fingerprintFiles(directory, paths) {
  const files = [];
  const visit = path => {
    for (const entry of readdirSync(resolve(directory, path), { withFileTypes: true })) {
      if (entry.isDirectory()) visit(`${path}/${entry.name}`);
      else if (entry.isFile()) files.push(`${path}/${entry.name}`);
    }
  };
  for (const path of paths) visit(path);
  files.sort();
  const digest = createHash('sha256');
  for (const path of files) digest.update(path).update('\0').update(readFileSync(resolve(directory, path))).update('\0');
  return { files: files.length, sha256: digest.digest('hex') };
}

// Every listed catalog entry must have a measured result; a required cohort
// that did not detect the fault is a regression named `<id>/<cohort>`.
export function requiredDetectionRegressions(entries, results) {
  return entries.flatMap(entry => {
    const result = results.find(item => item.id === entry.id);
    if (!result) throw new Error(`${entry.id}: catalog entry has no measured result`);
    return entry.requiredDetections.filter(cohort => result.cohorts[cohort].state !== 'detected').map(cohort => `${entry.id}/${cohort}`);
  });
}

export function typescriptDetection(mutations, cases) {
  const comparisons = ['ordinary', 'generated', 'portable'];
  const score = selected => Object.fromEntries(comparisons.map(cohort => {
    const detected = selected.filter(m => m.cohorts[cohort].state === 'detected');
    const ordinary = selected.filter(m => m.cohorts.ordinary.state === 'detected');
    return [cohort, { detected: detected.length, total: selected.length,
      ordinaryParity: { detected: ordinary.filter(m => m.cohorts[cohort].state === 'detected').length, total: ordinary.length },
      survivors: selected.filter(m => m.cohorts[cohort].state === 'survived').map(m => m.id) }];
  }));
  const protocol = m => cases.find(c => c.id === m.case).vectors.length > 0;
  return { all: score(mutations), behavioral: score(mutations.filter(m => !protocol(m))), protocol: score(mutations.filter(protocol)) };
}

export function goDetection(mutations) {
  return Object.fromEntries(['ordinary', 'generated', 'fixed', 'portable'].map(cohort => [cohort, {
    detected: mutations.filter(m => m.cohorts[cohort].state === 'detected').length, total: mutations.length,
    survivors: mutations.filter(m => m.cohorts[cohort].state === 'survived').map(m => m.id),
  }]));
}

function typescriptMarkdown(report) {
  return ['# Semantic coverage measurement', '',
    `Completed in ${report.elapsedSeconds}s. Inventory and mutation counts describe named cases, not universal semantic completeness.`, '',
    ...shardsMarkdown(report),
    '| Scope | Cases | Portable execution references | Required generated witnesses |',
    '| --- | ---: | ---: | ---: |',
    ...['cases', 'behavioral', 'protocol'].map(scope => { const c = report.declaredCoverage[scope]; return `| ${scope} | ${c.total} | ${c.portable} | ${c.generated} |`; }), '',
    'Protocol references include invalidation vectors exercised separately by integration CI. Model references are a conservative named-property subset, not total model coverage.', '',
    '| Mutation | Case | Ordinary | Generated | Full portable |', '| --- | --- | --- | --- | --- |',
    ...report.mutations.map(m => `| ${m.id} | ${m.case} | ${m.cohorts.ordinary.state} | ${m.cohorts.generated.state} | ${m.cohorts.portable.state} |`), '',
    'Full JSON includes exact input/corpus hashes, cohort counts, reached witnesses, behavioral/protocol scores, and failing test names. Adjacent JSON/log files retain assertion diagnostics and trace paths.', ''].join('\n');
}

function goMarkdown(report) {
  return ['# Go semantic mutation measurement', '', `Completed in ${report.elapsedSeconds}s. Counts measure this named fault catalog and exact corpus, not universal equivalence.`, '',
    ...shardsMarkdown(report),
    '| Mutation | Contract case | Ordinary | Quint generated | Fixed supplement | Full portable |', '| --- | --- | --- | --- | --- | --- |',
    ...report.mutations.map(m => `| ${m.id} | ${m.case} | ${m.cohorts.ordinary.state} | ${m.cohorts.generated.state} | ${m.cohorts.fixed.state} | ${m.cohorts.portable.state} |`), '',
    'Full JSON records snapshot/corpus/witness fingerprints, selected tests, actual passing/failing leaf counts, and assertion diagnostics. Compilation errors, crashes, timeouts, missing witnesses, and skipped executions cannot count as detections.', ''].join('\n');
}

// Only a merged report carries `shards`; the single run's markdown is unchanged.
function shardsMarkdown(report) {
  if (!report.shards) return [];
  return [`Merged from ${report.shards.length} shards that each reran the baselines: ${report.shards.map(s => `${s.index} (${s.mutationIds.join(', ') || 'no mutations'}, ${s.elapsedSeconds}s)`).join('; ')}.`, ''];
}

// Per-language knowledge: where the report lives, which catalog and inputs it
// measures, how its detection summary is scored and rendered, and whether the
// report records the regression list (the Go report does; the TypeScript
// report only fails on it).
export const languages = {
  ts: { name: 'TypeScript', output: '.formal-traces/semantic', catalog: 'formal/semantic-mutations.json', inputs: ['src', 'test', 'formal'],
    detection: (mutations, directory) => typescriptDetection(mutations, JSON.parse(readFileSync(resolve(directory, 'formal/semantic-cases.json'), 'utf8')).cases),
    markdown: typescriptMarkdown, recordsRegressions: false },
  go: { name: 'Go', output: '.formal-traces/go-semantic', catalog: 'formal/go-mutations.json', inputs: ['formal', 'go', 'test', 'src'],
    detection: mutations => goDetection(mutations), markdown: goMarkdown, recordsRegressions: true },
};

// The same gate for a shard (its own catalog entries, no summary), the
// single-process run and the merge (the whole catalog, summary, completion).
// A shard therefore fails on its own lost detections before any merge, and the
// merged summary is computed by the code the single run uses.
export function gateDetections(language, report, entries, { directory = root, summarize = true } = {}) {
  const regressions = requiredDetectionRegressions(entries, report.mutations);
  if (summarize) report.detection = language.detection(report.mutations, directory);
  if (language.recordsRegressions) report.requiredDetectionRegressions = regressions;
  if (regressions.length) throw new Error(`Lost required detections: ${regressions.join(', ')}`);
  if (summarize) report.complete = true;
}
