// Style measurements and two mechanical caps for the Quint sources.
//
// `--report` prints the measurement table lan17/DialCache#220 tracks, so
// progress is reproducible: lines over 120 characters, module header
// lengths, comment and guide sentence lengths, parameter widths and the
// free-text exclusion reasons. Those are reported only; the editorial
// guidance for them is AUTHORING.md "Writing conventions".
//
// Without arguments two rules are enforced, because guidance alone did not
// hold for them: a Quint line is at most 120 characters and a module header
// is at most 25 comment lines. The header is the `//` comment block beside
// the `module` line: the contiguous comment lines directly above it plus the
// comment lines below it up to the first import or definition (blank lines
// between them allowed), so a header written before `module`, as the kernel
// fixtures do, counts the same as one written after. Enforcement is over the
// `.qnt` files under formal/models not named in
// formal/catalogs/style-allowlist.json. The allowlist names today's
// offenders per rule and carries no counts; a file that becomes clean must be
// deleted from it (a stale entry fails the check), so the list may only
// shrink, and adding an entry is a reviewed exception.
//
// Measurement definitions, so the report is reproducible: a comment sentence
// is a run of full-line `//` comments joined by spaces, with banner lines
// (dashes only, or a title between dashes) removed, split before a capital
// letter, backtick, bracket or parenthesis that follows sentence punctuation;
// a guide sentence is the same split over a paragraph outside headings, tables
// and code fences; a definition is a `def`, `pure def` or `action` with its
// parameter list scanned to the matching parenthesis.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const allowlistPath = 'formal/catalogs/style-allowlist.json';
export const caps = { lineLength: 120, headerLength: 25 };
const read = (path, directory) => readFileSync(resolve(directory, path), 'utf8');

export function quintFiles(directory = root) {
  const walk = relative => readdirSync(resolve(directory, relative), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(`${relative}/${entry.name}`) : entry.name.endsWith('.qnt') ? [`${relative}/${entry.name}`] : []);
  return walk('formal/models').sort();
}

// The header: comment lines after the `module` line, up to the first line
// that is neither blank nor a comment.
export function headerLines(lines) {
  const start = lines.findIndex(line => /^\s*module\s+\w+/.test(line));
  if (start < 0) return 0;
  let count = 0;
  for (let index = start - 1; index >= 0; index--) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('//')) count++;
    else if (trimmed !== '') break;
  }
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) count++;
    else if (trimmed !== '') break;
  }
  return count;
}

const isBanner = text => /^-{3,}/.test(text) || /^-{2,}\s.*\s-{2,}$/.test(text);

// Every def, pure def and action with its parameters, the list scanned to the
// matching parenthesis so an operator-typed parameter is one parameter.
export function definitions(text) {
  const found = [];
  for (const match of text.matchAll(/\b(?:pure\s+)?(?:def|action)\s+(\w+)\s*\(/g)) {
    let depth = 1, index = match.index + match[0].length, start = index;
    const params = [];
    for (; index < text.length && depth > 0; index++) {
      const char = text[index];
      if (char === '(' || char === '[') depth++;
      else if (char === ')' || char === ']') { depth--; if (depth === 0) break; }
      else if (char === ',' && depth === 1) { params.push(text.slice(start, index)); start = index + 1; }
    }
    const last = text.slice(start, index).trim();
    if (last) params.push(last);
    found.push({ name: match[1], params: params.map(param => param.trim()).filter(Boolean) });
  }
  return found;
}

const sentences = text => text.split(/(?<=[.!?])\s+(?=[A-Z`\[(])/).map(s => s.split(/\s+/).filter(Boolean).length).filter(Boolean);
const area = path => path.includes('/fixtures/') ? 'fixtures' : path.includes('/kernel/') ? 'kernel' : 'models';

export function measure(directory = root) {
  const files = quintFiles(directory);
  const areas = { models: 0, kernel: 0, fixtures: 0 };
  const wide = { models: 0, kernel: 0, fixtures: 0 };
  let longLines = 0, headerTotal = 0, headerMax = 0, headersOver = 0, definitionCount = 0;
  const twoBooleans = [];
  const commentWords = [];
  for (const path of files) {
    const text = read(path, directory);
    const lines = text.split('\n');
    const over = lines.filter(line => line.length > caps.lineLength).length;
    longLines += over;
    areas[area(path)] += over;
    const header = headerLines(lines);
    headerTotal += header; headerMax = Math.max(headerMax, header); headersOver += header > caps.headerLength;
    const comments = lines.filter(line => line.trim().startsWith('//')).map(line => line.trim().replace(/^\/\/\s?/, '')).filter(line => !isBanner(line));
    commentWords.push(...sentences(comments.join(' ')));
    for (const definition of definitions(text)) {
      definitionCount++;
      if (definition.params.length >= 6) wide[area(path)]++;
      const booleans = definition.params.filter(param => param.split(':').at(-1).trim() === 'bool').length;
      if (booleans >= 2) twoBooleans.push(`${path.replace(/^formal\/models\//, '')}:${definition.name}`);
    }
  }
  const guideWords = [];
  for (const path of [...readdirSync(resolve(directory, 'formal/guides')).filter(p => p.endsWith('.md')).map(p => `formal/guides/${p}`), 'formal/README.md']) {
    const text = read(path, directory).replace(/```[\s\S]*?```/g, '');
    for (const paragraph of text.split(/\n\s*\n/)) {
      if (/^\s*[#|]/.test(paragraph)) continue;
      guideWords.push(...sentences(paragraph.split('\n').map(line => line.trim()).join(' ')));
    }
  }
  const execution = JSON.parse(read('formal/catalogs/execution.json', directory));
  const exclusionReasons = (execution.challenges ?? []).reduce((count, challenge) => count + Object.values(challenge.reproducer?.exclusions ?? {}).filter(value => typeof value === 'string').length, 0);
  const average = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length * 10) / 10 : 0;
  const distribution = values => ({ count: values.length, over40: values.filter(w => w > 40).length, over60: values.filter(w => w > 60).length, over100: values.filter(w => w > 100).length, longest: Math.max(0, ...values), averageWords: average(values) });
  return {
    files: files.length,
    linesOver: { total: longLines, ...areas },
    headers: { total: headerTotal, longest: headerMax, overCap: headersOver },
    commentSentences: distribution(commentWords),
    guideSentences: distribution(guideWords),
    definitions: { count: definitionCount, sixOrMoreParameters: wide, twoBooleanParameters: twoBooleans },
    exclusionReasons,
  };
}

export function renderReport(m) {
  return [
    '| Measure | Value |', '| --- | --- |',
    `| Quint files under formal/models | ${m.files} |`,
    `| Lines over ${caps.lineLength} characters (models / kernel / fixtures) | ${m.linesOver.total} (${m.linesOver.models} / ${m.linesOver.kernel} / ${m.linesOver.fixtures}) |`,
    `| Module header comment lines, total / longest / over ${caps.headerLength} | ${m.headers.total} / ${m.headers.longest} / ${m.headers.overCap} |`,
    `| Quint comment sentences, count / over 40 / over 60 / over 100 words / longest / average | ${m.commentSentences.count} / ${m.commentSentences.over40} / ${m.commentSentences.over60} / ${m.commentSentences.over100} / ${m.commentSentences.longest} / ${m.commentSentences.averageWords} |`,
    `| Guide sentences, count / over 40 / over 60 / over 100 words / longest / average | ${m.guideSentences.count} / ${m.guideSentences.over40} / ${m.guideSentences.over60} / ${m.guideSentences.over100} / ${m.guideSentences.longest} / ${m.guideSentences.averageWords} |`,
    `| Definitions, count / six or more parameters (models / kernel / fixtures) | ${m.definitions.count} / ${m.definitions.sixOrMoreParameters.models + m.definitions.sixOrMoreParameters.kernel + m.definitions.sixOrMoreParameters.fixtures} (${m.definitions.sixOrMoreParameters.models} / ${m.definitions.sixOrMoreParameters.kernel} / ${m.definitions.sixOrMoreParameters.fixtures}) |`,
    `| Definitions taking two or more boolean parameters | ${m.definitions.twoBooleanParameters.length} (${m.definitions.twoBooleanParameters.join(', ') || 'none'}) |`,
    `| Free-text exclusion reasons in execution.json | ${m.exclusionReasons} |`,
  ].join('\n') + '\n';
}

// The two caps over every file not allowlisted for that rule; an allowlisted
// file that is clean is reported too, so the list only ever shrinks.
export function checkStyle({ directory = root, allowlist = JSON.parse(read(allowlistPath, directory)) } = {}) {
  const failures = [];
  const listed = { lineLength: new Set(allowlist.lineLength ?? []), headerLength: new Set(allowlist.headerLength ?? []) };
  const files = quintFiles(directory);
  for (const rule of Object.keys(listed)) for (const path of listed[rule]) if (!files.includes(path)) failures.push(`${allowlistPath}: ${rule} names a file that is not a Quint source under formal/models: ${path}`);
  let checked = 0;
  for (const path of files) {
    const lines = read(path, directory).split('\n');
    const long = lines.map((line, index) => line.length > caps.lineLength ? index + 1 : 0).filter(Boolean);
    const header = headerLines(lines);
    if (listed.lineLength.has(path)) { if (!long.length) failures.push(`${allowlistPath}: ${path} has no line over ${caps.lineLength}; delete its lineLength entry`); }
    else { checked++; for (const line of long) failures.push(`${path}:${line}: line over ${caps.lineLength} characters`); }
    if (listed.headerLength.has(path)) { if (header <= caps.headerLength) failures.push(`${allowlistPath}: ${path} has a header within ${caps.headerLength} lines; delete its headerLength entry`); }
    else if (header > caps.headerLength) failures.push(`${path}: module header has ${header} comment lines (cap ${caps.headerLength})`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return { files: files.length, lineLengthChecked: checked, allowlisted: listed.lineLength.size + listed.headerLength.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag] = process.argv.slice(2);
  if (flag === '--report') process.stdout.write(renderReport(measure()));
  else if (flag === undefined) console.log(checkStyle());
  else { console.error('Usage: node formal/tools/check-style.mjs [--report]'); process.exitCode = 2; }
}
