import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(root + path, 'utf8');

export function sourceSnapshot() {
  const paths = ['README.md', ...readdirSync(root + 'docs').filter(p => p.endsWith('.md')).map(p => 'docs/' + p),
    ...readdirSync(root + 'test').filter(p => p.endsWith('.test.ts') && !p.startsWith('formal-')).map(p => 'test/' + p)];
  return paths.sort().map(path => {
    const text = read(path);
    const entries = [];
    if (path.endsWith('.ts')) {
      const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isCallExpression(node) && /^(it|test)(\.|\(|$)/.test(node.expression.getText(ast))) {
          const title = node.arguments[0];
          const body = node.arguments.at(-1);
          if (title && body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body))) {
            entries.push({ line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
              title: ts.isStringLiteralLike(title) ? title.text : title.getText(ast) });
            return;
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(ast);
      if (entries.length === 0) throw new Error(`No recognized test declarations: ${path}`);
    } else {
      let fence;
      for (const [i, line] of text.split('\n').entries()) {
        const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (marker) {
          if (!fence) fence = marker[0];
          else if (fence === marker[0]) fence = undefined;
        } else if (!fence && /^#{1,6} /.test(line)) entries.push({ line: i + 1, title: line.replace(/^#+ /, '') });
      }
    }
    return { path, sha256: createHash('sha256').update(text).digest('hex'), entries };
  });
}

export function checkSourceAudit() {
  const audit = JSON.parse(read('formal/source-audit.json'));
  if (audit.schemaVersion !== 1) throw new Error('Unsupported formal source audit version');
  const actual = sourceSnapshot();
  const ids = new Set([...read('formal/CONTRACTS.md').matchAll(/^\| ([CWEBX]\d{2}) \|/gm)].map(m => m[1]));
  const failures = [];
  if (JSON.stringify(actual.map(s => s.path)) !== JSON.stringify(audit.sources.map(s => s.path))) failures.push('Source file inventory changed');
  for (const source of actual) {
    const saved = audit.sources.find(s => s.path === source.path);
    if (!saved) continue;
    if (saved.sha256 !== source.sha256) failures.push(`${source.path}: contents changed; review assertions/prose and refresh its audit`);
    if (JSON.stringify(saved.entries.map(({ line, title }) => ({ line, title }))) !== JSON.stringify(source.entries)) failures.push(`${source.path}: test/section inventory changed`);
    for (const entry of saved.entries) {
      if (!Array.isArray(entry.contracts) || entry.contracts.length === 0 || entry.contracts.some(id => !ids.has(id))) failures.push(`${source.path}:${entry.line}: missing or unknown contract disposition`);
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return { sources: actual.length, tests: actual.filter(s => s.path.endsWith('.ts')).reduce((n, s) => n + s.entries.length, 0),
    sections: actual.filter(s => s.path.endsWith('.md')).reduce((n, s) => n + s.entries.length, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(checkSourceAudit());
