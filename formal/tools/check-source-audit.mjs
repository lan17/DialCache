import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { encodeJson } from './compact-json.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path, directory = root) => readFileSync(resolve(directory, path), 'utf8');
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// An entry is a heading or a test declaration, identified by its title and its
// position among entries with the same title, never by a line number: prose
// edits above a heading do not move it. Headings inside fenced examples are
// not documentation sections. A shorter marker or a marker followed by text
// cannot close the surrounding code fence.
function markdownHeadings(text) {
  const entries = [];
  let fence;
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
      if (close?.[0] === fence.marker && close.length >= fence.length) fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
      fence = { marker: open[1][0], length: open[1].length };
      continue;
    }
    const heading = /^ {0,3}#{1,6}[ \t]+(.*)$/.exec(line);
    if (heading) entries.push({ title: heading[1] });
  }
  return entries;
}

function snapshot(paths, directory) {
  return paths.sort().map(path => {
    const text = read(path, directory);
    let entries = [];
    if (path.endsWith('.ts')) {
      const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && /^(it|test)(\.|\(|$)/.test(node.expression.getText(ast))) {
          const title = node.arguments[0];
          const body = node.arguments.at(-1);
          if (title && body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
            entries.push({ title: ts.isStringLiteralLike(title) ? title.text : title.getText(ast) });
            return;
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
      if (entries.length === 0) throw new Error(`No recognized test declarations: ${path}`);
    } else entries = markdownHeadings(text);
    return { path, sha256: createHash('sha256').update(text).digest('hex'), entries };
  });
}

export function sourceSnapshot(directory = root) {
  const documentation = (path) => readdirSync(resolve(directory, path), { withFileTypes: true }).flatMap(entry =>
    ['.vitepress', 'public', 'generated'].includes(entry.name) ? []
      : entry.isDirectory() ? documentation(`${path}/${entry.name}`)
        : entry.name.endsWith('.md') ? [`${path}/${entry.name}`] : []);
  const paths = ['README.md', 'typescript/README.md', ...documentation('docs'),
    ...readdirSync(resolve(directory, 'typescript/test')).filter(p => p.endsWith('.test.ts') && !p.startsWith('formal-')).map(p => 'typescript/test/' + p)];
  return snapshot(paths, directory);
}

export function guideSnapshot(directory = root) {
  const paths = [...readdirSync(resolve(directory, 'formal/guides')).filter(p => p.endsWith('.md')).map(p => 'formal/guides/' + p), 'formal/README.md', 'go/README.md'];
  return snapshot(paths, directory);
}

export const auditPath = 'formal/catalogs/source-audit.json';
// The audit as committed: pretty JSON with every heading or test entry on one line.
export const encodeAudit = audit => encodeJson(audit, path => path.length >= 3 && path.at(-2) === 'entries' && typeof path.at(-1) === 'number');

// What the Go parity ledger binds to: the audit's schema, each test source's
// content hash, every disposition (path, title, contracts) and each reviewed
// guide's path and review record. Not a documentation file's hash: prose that
// keeps its headings and dispositions is this audit's business alone, so a
// prose edit leaves the parity ledger untouched while a changed assertion, a
// new section or a changed disposition reaches it.
export function dispositionDigest(audit) {
  const bound = {
    schemaVersion: audit?.schemaVersion,
    sources: (audit?.sources ?? []).map(source => ({ path: source?.path, sha256: source?.path?.endsWith('.ts') ? source.sha256 : undefined,
      entries: (source?.entries ?? []).map(entry => ({ title: entry?.title, contracts: entry?.contracts })) })),
    reviewedGuides: (audit?.reviewedGuides ?? []).map(guide => ({ path: guide?.path, review: guide?.review })),
  };
  return createHash('sha256').update(JSON.stringify(bound)).digest('hex');
}

// A refreshed file's entries keep their dispositions by title: the k-th
// occurrence of a title keeps what the k-th occurrence had, so a moved section
// keeps its contracts and a renamed or new one starts empty.
function carryDispositions(previous = [], entries) {
  const seen = new Map();
  return entries.map(entry => {
    const occurrence = seen.get(entry.title) ?? 0;
    seen.set(entry.title, occurrence + 1);
    const match = previous.filter(candidate => candidate?.title === entry.title)[occurrence];
    return { ...entry, contracts: match?.contracts ?? [] };
  });
}

// Re-key the named files after their review. For each: recompute its hash and
// entry inventory, carry its contract dispositions by title and give a new
// entry an empty disposition, so the check fails until a reviewer fills it. A
// named file that joined the inventory is added at its sorted position, a
// guide without its review record; one that left the inventory is dropped.
// Files not named keep their rows as they are. Nothing here assigns a
// disposition or writes a review.
export function refreshSourceAudit(audit, paths, { directory = root } = {}) {
  const snapshots = { sources: sourceSnapshot(directory), reviewedGuides: guideSnapshot(directory) };
  const result = { ...audit, sources: [...(audit.sources ?? [])], reviewedGuides: [...(audit.reviewedGuides ?? [])] };
  const changes = [];
  for (const path of paths.map(given => given.replace(/^\.\//, ''))) {
    const kind = ['sources', 'reviewedGuides'].find(name => snapshots[name].some(source => source.path === path) || result[name].some(row => row?.path === path));
    if (!kind) throw new Error(`${path}: not an audited source or reviewed guide`);
    const rows = result[kind];
    const index = rows.findIndex(row => row?.path === path);
    const source = snapshots[kind].find(candidate => candidate.path === path);
    if (!source) {
      rows.splice(index, 1);
      changes.push({ path, action: 'removed' });
      continue;
    }
    const previous = index >= 0 ? rows[index] : undefined;
    const entries = kind === 'sources' ? carryDispositions(previous?.entries, source.entries) : source.entries;
    const row = previous ? { ...previous, sha256: source.sha256, entries } : { path, sha256: source.sha256, entries };
    const pending = entries.filter(entry => entry.contracts?.length === 0).map(entry => JSON.stringify(entry.title));
    if (previous && previous.sha256 === row.sha256 && equal(previous.entries, entries)) {
      changes.push({ path, action: 'unchanged', entries: entries.length, pending });
      continue;
    }
    if (previous) rows[index] = row;
    else {
      const at = rows.findIndex(other => other?.path > path);
      rows.splice(at < 0 ? rows.length : at, 0, row);
    }
    changes.push({ path, action: previous ? 'refreshed' : 'added', entries: entries.length, pending, review: kind !== 'reviewedGuides' || Boolean(row.review) });
  }
  return { audit: result, changes };
}

export function describeChange({ path, action, entries, pending = [], review = true }) {
  if (action === 'removed') return `${path}: removed, no longer in the inventory`;
  const needs = [
    pending.length ? `${pending.length} without a contract disposition: ${pending.join(', ')}` : '',
    review ? '' : 'its review record is missing',
  ].filter(Boolean);
  return `${path}: ${action}, ${entries} ${entries === 1 ? 'entry' : 'entries'}${needs.length ? `; ${needs.join('; ')}` : ''}`;
}

export function checkSourceAudit(audit, { directory = root } = {}) {
  if (audit === undefined) audit = JSON.parse(read(auditPath, directory));
  if (audit?.schemaVersion !== 2) throw new Error('Unsupported formal source audit version');
  const actual = sourceSnapshot(directory), guides = guideSnapshot(directory);
  const ids = new Set([...read('formal/guides/CONTRACTS.md', directory).matchAll(/^\| ([CWEBX]\d{2}) \|/gm)].map(m => m[1]));
  const failures = [];
  const sources = Array.isArray(audit.sources) ? audit.sources : [];
  const reviewedGuides = Array.isArray(audit.reviewedGuides) ? audit.reviewedGuides : [];
  if (!equal(actual.map(s => s.path), sources.map(s => s?.path))) failures.push('Source file inventory changed');
  if (!Array.isArray(audit.reviewedGuides) || !equal(guides.map(s => s.path), reviewedGuides.map(s => s?.path))) failures.push('Reviewed guide file inventory changed');
  const validContracts = contracts => Array.isArray(contracts) && new Set(contracts).size === contracts.length && contracts.every(id => ids.has(id));
  const compareSnapshot = (source, saved, label) => {
    if (saved.sha256 !== source.sha256) failures.push(`${source.path}: contents changed; review assertions/prose and refresh its audit`);
    if (!Array.isArray(saved.entries) || !equal(saved.entries.map(entry => ({ title: entry?.title })), source.entries)) failures.push(`${source.path}: ${label} inventory changed`);
  };
  for (const source of actual) {
    const saved = sources.find(s => s?.path === source.path);
    if (!saved) continue;
    compareSnapshot(source, saved, 'test/section');
    for (const entry of Array.isArray(saved.entries) ? saved.entries : []) {
      if (!validContracts(entry?.contracts) || entry.contracts.length === 0) failures.push(`${source.path} ${JSON.stringify(entry?.title)}: missing, duplicate or unknown contract disposition`);
    }
  }
  const kinds = new Set(['contract-guide', 'tooling-guide', 'coverage-guide', 'historical-evidence']);
  for (const source of guides) {
    const saved = reviewedGuides.find(s => s?.path === source.path);
    if (!saved) continue;
    compareSnapshot(source, saved, 'guide section');
    const review = saved.review;
    if (!review || !kinds.has(review.kind)) failures.push(`${source.path}: missing or invalid guide review kind`);
    if (typeof review?.scope !== 'string' || !review.scope.trim()) failures.push(`${source.path}: missing reviewed guide scope`);
    if (review?.contracts !== undefined && !validContracts(review.contracts) || review?.kind === 'contract-guide' && (!validContracts(review.contracts) || review.contracts.length === 0)) failures.push(`${source.path}: missing, duplicate or unknown guide contract IDs`);
    const revisions = review?.revisions;
    const validRevisions = Array.isArray(revisions) && revisions.every(revision => typeof revision === 'string' && /^[a-f\d]{40}$/i.test(revision)) && new Set(revisions.map(revision => revision.toLowerCase())).size === revisions.length;
    if (revisions !== undefined && !validRevisions || review?.kind === 'historical-evidence' && (!validRevisions || revisions.length === 0)) failures.push(`${source.path}: missing, duplicate or invalid historical revision identity`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return { sources: actual.length, tests: actual.filter(s => s.path.endsWith('.ts')).reduce((n, s) => n + s.entries.length, 0),
    sections: actual.filter(s => s.path.endsWith('.md')).reduce((n, s) => n + s.entries.length, 0),
    reviewedGuides: guides.length, guideSections: guides.reduce((n, s) => n + s.entries.length, 0) };
}

function main(argv) {
  if (argv.length === 0) return console.log(checkSourceAudit());
  if (argv[0] !== '--refresh' || argv.length < 2) {
    console.error('Usage: node formal/tools/check-source-audit.mjs [--refresh <path>...]');
    process.exitCode = 2;
    return;
  }
  const { audit, changes } = refreshSourceAudit(JSON.parse(read(auditPath)), argv.slice(1));
  writeFileSync(resolve(root, auditPath), encodeAudit(audit));
  for (const change of changes) console.log(describeChange(change));
  try { console.log(checkSourceAudit(audit)); }
  catch (error) {
    console.error(`\nThe audit still fails. Fill what is missing, then run the check again:\n${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
