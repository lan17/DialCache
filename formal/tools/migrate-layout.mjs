#!/usr/bin/env node
// One-shot migration for lan17/DialCache#221: group formal/ by role so the top
// level is one README and six directories. Committed in the first commit of the
// move and removed in its last; the review of the move is a review of this
// mapping. Usage: node formal/tools/migrate-layout.mjs [--dry-run]
//
// Three passes over the tracked files (git ls-files -z):
//   1. Markdown links: every relative link in every tracked .md file is
//      resolved against the file's old directory, mapped through the kind
//      rules, and re-relativized against the file's new directory.
//   2. git mv / git rm: every tracked file under formal/ moves per the kind
//      rules; replay/ and formal/README.md stay; the two one-line shell
//      wrappers are deleted.
//   3. Literal paths: every `formal/<name>` substring in every tracked file is
//      mapped through the kind rules, whatever relative prefix precedes it.
//
// The kind rules map by extension and name shape rather than by a list of real
// files, so synthetic paths in tests (formal/x.qnt, formal/NEW.md) follow the
// layout too, and the rules are idempotent: a mapped path never matches again.
// Interpolated paths (`formal/${name}`), escaped regex literals (formal\/...)
// and paths assembled from pieces are left for the hand-edit list in #221.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const tracked = () => git('ls-files', '-z').split('\0').filter(Boolean);

const NAME = '[A-Za-z0-9_-]+';
// A path ends where no word character, hyphen, or dot-plus-word-character
// follows: "formal/profiles.json" is matched inside "formal/profiles.json."
// at the end of a sentence but not inside "formal/profiles.jsonl".
const END = '(?![\\w-])(?!\\.[\\w])';
// Order matters: directories first, then the generated name shapes, then the
// extensions. A path mapped by one rule contains a directory segment after
// formal/ and therefore matches no later rule.
export const kindRules = [
  // The directory rules exclude a following dot so the ports' own test modules
  // under directories named formal/ (rust/tests/formal/fixtures.rs) stay put.
  [new RegExp(`formal/fixtures/kernel(?![\\w.-])`, 'g'), 'formal/models/fixtures/kernel'],
  [new RegExp(`formal/fixtures(?![\\w./-])`, 'g'), 'formal/models/fixtures'],
  [new RegExp(`formal/kernel(?![\\w.-])`, 'g'), 'formal/models/kernel'],
  [new RegExp(`formal/(${NAME})-smoke\\.itf\\.json${END}`, 'g'), 'formal/generated/$1-smoke.itf.json'],
  [new RegExp(`formal/(quint-${NAME}-vectors\\.json)${END}`, 'g'), 'formal/generated/$1'],
  [new RegExp(`formal/generated-fixtures\\.lock\\.json${END}`, 'g'), 'formal/generated/generated-fixtures.lock.json'],
  [new RegExp(`formal/(${NAME}\\.qnt)${END}`, 'g'), 'formal/models/$1'],
  [new RegExp(`formal/(${NAME}\\.d\\.mts)${END}`, 'g'), 'formal/tools/$1'],
  [new RegExp(`formal/(${NAME}\\.(?:mjs|mts|sh))${END}`, 'g'), 'formal/tools/$1'],
  [new RegExp(`formal/(?!README\\.md)(${NAME}\\.md)${END}`, 'g'), 'formal/guides/$1'],
  [new RegExp(`formal/(${NAME}\\.json)${END}`, 'g'), 'formal/catalogs/$1'],
];
export function mapPath(text) {
  let out = text;
  for (const [pattern, replacement] of kindRules) out = out.replace(pattern, replacement);
  return out;
}
const deleted = new Set(['formal/check.sh', 'formal/generate-traces.sh']);

// -- Pass 1: Markdown links -------------------------------------------------

function rewriteLinks(text, oldPath, newPath) {
  const oldDir = posix.dirname(oldPath), newDir = posix.dirname(newPath);
  let count = 0;
  const remap = target => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target)) return target;
    const hashAt = target.indexOf('#');
    const path = hashAt < 0 ? target : target.slice(0, hashAt), hash = hashAt < 0 ? '' : target.slice(hashAt);
    if (!path) return target;
    const trailingSlash = path.endsWith('/');
    const oldAbsolute = posix.normalize(posix.join(oldDir, path)).replace(/\/$/, '');
    const newAbsolute = mapPath(oldAbsolute);
    if (newAbsolute === oldAbsolute && oldDir === newDir) return target;
    let relative = posix.relative(newDir, newAbsolute) || '.';
    if (path.startsWith('./') && !relative.startsWith('.')) relative = `./${relative}`;
    if (trailingSlash && !relative.endsWith('/')) relative += '/';
    if (relative !== path) count++;
    return relative + hash;
  };
  const out = text
    .replace(/\]\(([^)\s]+)\)/g, (match, target) => `](${remap(target)})`)
    .replace(/^(\[[^\]]+\]:[ \t]+)(\S+)/gm, (match, label, target) => `${label}${remap(target)}`);
  return { out, count };
}

// -- Main ----------------------------------------------------------------------

const files = tracked();
const moves = files.filter(path => path.startsWith('formal/') && !deleted.has(path)).map(path => [path, mapPath(path)]).filter(([from, to]) => from !== to);
const byDirectory = {};
for (const [, to] of moves) { const directory = to.split('/').slice(0, 2).join('/'); byDirectory[directory] = (byDirectory[directory] || 0) + 1; }
console.log(`tracked files: ${files.length}; moves: ${moves.length}; deletions: ${deleted.size}`);
for (const [directory, count] of Object.entries(byDirectory).sort()) console.log(`  ${directory}: ${count}`);
const staying = files.filter(path => path.startsWith('formal/') && mapPath(path) === path && !deleted.has(path));
console.log(`  staying under formal/: ${staying.length} (${staying.filter(p => !p.startsWith('formal/replay/')).join(', ')} + replay/)`);

// Pass 1 on the original tree.
let linkEdits = 0, linkFiles = 0;
const moveMap = new Map(moves);
for (const path of files.filter(path => path.endsWith('.md'))) {
  const absolute = resolve(root, path);
  const text = readFileSync(absolute, 'utf8');
  const { out, count } = rewriteLinks(text, path, moveMap.get(path) ?? path);
  if (count) { linkEdits += count; linkFiles++; if (!dryRun) writeFileSync(absolute, out); }
}
console.log(`markdown links rewritten: ${linkEdits} in ${linkFiles} files`);

// Pass 2: move.
if (!dryRun) {
  for (const [from, to] of moves) {
    mkdirSync(dirname(resolve(root, to)), { recursive: true });
    git('mv', from, to);
  }
  for (const path of deleted) if (existsSync(resolve(root, path))) git('rm', '-q', path);
}

// Pass 3: literal paths, on the moved tree.
const current = dryRun ? files.filter(path => !deleted.has(path)).map(path => [path, moveMap.get(path) ?? path]) : tracked().map(path => [path, path]);
let literalEdits = 0; const perFile = [];
for (const [readFrom, logicalPath] of current) {
  if (logicalPath === 'formal/tools/migrate-layout.mjs') continue;
  const absolute = resolve(root, readFrom);
  if (!existsSync(absolute)) continue;
  const text = readFileSync(absolute, 'utf8');
  // A line marked layout-legacy names pre-move paths on purpose (the
  // differential's reader of older revisions) and is never rewritten.
  const out = text.split('\n').map(line => line.includes('layout-legacy') ? line : mapPath(line)).join('\n');
  if (out === text) continue;
  const count = (text.match(/formal\//g) || []).length - (out.match(/\bformal\/(?=[A-Za-z0-9_-]+\.(?:qnt|json|mjs|mts|sh|md)(?![\w.-]))/g) || []).length;
  literalEdits += Math.max(count, 1); perFile.push([logicalPath, Math.max(count, 1)]);
  if (!dryRun) writeFileSync(absolute, out);
}
perFile.sort((a, b) => b[1] - a[1]);
console.log(`literal path edits: about ${literalEdits} in ${perFile.length} files; top: ${perFile.slice(0, 8).map(([p, n]) => `${p} (${n})`).join(', ')}`);
if (dryRun) console.log('dry run: nothing written');
