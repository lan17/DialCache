// The course under formal/guides/course/ points at files by line and quotes the
// inventory that execution.mjs prints. Both drift as the tree changes, and a
// learner is the one who finds out. This check keeps every lesson honest about
// where it points:
//
// - A line citation ("lines 65 to 86", "line 141") names its file through the
//   nearest plain Markdown link before it in the same bullet or paragraph
//   (a link with a #fragment is a glossary or guide pointer, not a file), or
//   the link it sits inside, and names a backticked symbol in the same clause
//   or just before itself. The symbol must appear on those lines of that file
//   today.
// - A quoted inventory count ("regressions": 468) must equal what
//   `node formal/tools/execution.mjs` prints today; a lesson that wants to show
//   a count changing says so in words instead of quoting a stale number.
//
// `make audit` runs it. A failure names the lesson, the citation and what is
// missing; fixing the citation is the mechanical part, and the lesson around
// it is reread by hand, because only a reader can tell when the idea moved.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const courseDirectory = 'formal/guides/course';
const read = (path, directory) => readFileSync(resolve(directory, path), 'utf8');

export function lessons(directory = root) {
  const dir = resolve(directory, courseDirectory);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.md')).sort().map(f => `${courseDirectory}/${f}`);
}

// Fenced code is not prose: blank it but keep the line structure.
const withoutFences = text => text.replace(/```[\s\S]*?```/g, fence => fence.replace(/[^\n]/g, ' '));

// Blocks: paragraphs split on blank lines, and list items split where a bullet starts.
export function blocks(text) {
  return withoutFences(text).split(/\n\s*\n/).flatMap(p => p.split(/\n(?=\s*- )/))
    .map(b => b.replace(/\n\s*/g, ' ').trim()).filter(Boolean);
}

const linkTarget = /\]\(([^)#\s]+)\)/g;
const isLocal = path => !/^[a-z]+:/.test(path);

// Every "lines N to M" / "line N" with the file it names, the symbols in its clause and the clause itself.
export function citations(text) {
  const found = [];
  for (const block of blocks(text)) {
    // Inline code is masked so an example such as `lines 65 to 86` is not read as a citation.
    const masked = block.replace(/`[^`]*`/g, span => `\`${' '.repeat(span.length - 2)}\``);
    for (const m of masked.matchAll(/\b[Ll]ines? (\d+)(?: (?:to|and) (\d+))?\b/g)) {
      const before = block.slice(0, m.index);
      const after = block.slice(m.index + m[0].length);
      const preceding = [...before.matchAll(linkTarget)].map(x => x[1]).filter(isLocal).pop();
      const inside = after.match(/^[^[\]]*?\]\(([^)#\s]+)\)/);
      const file = inside && isLocal(inside[1]) ? inside[1] : preceding;
      const clauseEnd = after.search(/(?<=[.;])\s+(?=[A-Z])|\s[Ll]ines? \d+\b/);
      const clause = (clauseEnd < 0 ? after : after.slice(0, clauseEnd)).trim();
      const tokens = [...clause.matchAll(/`([^`]+)`/g)].map(x => x[1]);
      const leading = before.match(/`([^`]+)`[^`.;]{0,12}$/);
      if (leading) tokens.push(leading[1]);
      found.push({ citation: m[0], start: Number(m[1]), end: Number(m[2] ?? m[1]), file, tokens, clause });
    }
  }
  return found;
}

// Quoted inventory counts, in prose or in an expected-output block: "regressions": 468.
export function quotedCounts(text) {
  return [...text.matchAll(/"(\w+)":\s*(\d+)\b/g)].map(m => ({ key: m[1], value: Number(m[2]) }));
}

export function inventory(directory = root) {
  const result = spawnSync(process.execPath, ['formal/tools/execution.mjs'], { cwd: directory, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`execution.mjs failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

export function checkCourse({ directory = root, inventory: counts = inventory(directory) } = {}) {
  const errors = [];
  let citationTotal = 0, countTotal = 0;
  const files = lessons(directory);
  for (const lesson of files) {
    const text = read(lesson, directory);
    for (const c of citations(text)) {
      citationTotal++;
      const where = `${lesson}: "${c.citation}"`;
      if (!c.file) { errors.push(`${where}: no file link before the citation in its bullet or paragraph`); continue; }
      const target = resolve(directory, dirname(lesson), c.file);
      if (!existsSync(target)) { errors.push(`${where}: ${c.file} does not exist`); continue; }
      const lines = readFileSync(target, 'utf8').split('\n');
      if (c.start < 1 || c.end < c.start || c.end > lines.length) { errors.push(`${where}: ${c.file} has ${lines.length} lines`); continue; }
      if (c.tokens.length === 0) { errors.push(`${where}: no backticked symbol in the clause "${c.clause.slice(0, 60)}"; name what those lines contain`); continue; }
      const range = lines.slice(c.start - 1, c.end).join('\n');
      if (!c.tokens.some(t => range.includes(t))) errors.push(`${where}: none of ${c.tokens.map(t => `\`${t}\``).join(', ')} appears on those lines of ${c.file}`);
    }
    for (const q of quotedCounts(text)) {
      if (!(q.key in counts)) continue;
      countTotal++;
      if (counts[q.key] !== q.value) errors.push(`${lesson}: quotes "${q.key}": ${q.value}; the inventory prints ${counts[q.key]}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { lessons: files.length, citations: citationTotal, counts: countTotal };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(checkCourse());
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
