import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDeclarationBodies } from '../formal/execution.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' });
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const source = path => `https://github.com/lan17/DialCache/blob/${revision}/${path}`;
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Public symbol inventories come from each language's own tool, at this checkout.
// Prose in doc comments remains reviewed source; generation does not prove it.
if (!process.argv.includes('--catalogue-only')) {
  const destination = resolve(root, 'docs/public/reference');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  run('corepack', ['pnpm', 'exec', 'typedoc']);
  const go = execFileSync('go', ['doc', '-all', '.'], { cwd: resolve(root, 'go'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  mkdirSync(resolve(destination, 'go'), { recursive: true });
  writeFileSync(resolve(destination, 'go/index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DialCache Go API</title><style>body{font:16px/1.6 system-ui;margin:2rem auto;padding:0 1rem;max-width:80rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}a{color:#3451b2}@media(prefers-color-scheme:dark){body{background:#1b1b1f;color:#dfdfd6}a{color:#a8b1ff}}</style></head>
<body><nav><a href="../../api.html">All languages</a> · <a href="../../languages/go.html">Go guide</a></nav>
<h1>DialCache Go API</h1><p>Generated with <code>go doc -all</code> from <a href="${source('go')}">${revision.slice(0, 7)}</a>. Use your browser's Find command to locate a symbol.</p>
<pre>${escape(go)}</pre></body></html>\n`);
  run('cargo', ['doc', '--locked', '--all-features', '--no-deps'], resolve(root, 'rust'));
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--format-version=1', '--no-deps'], { cwd: resolve(root, 'rust'), encoding: 'utf8' }));
  cpSync(resolve(metadata.target_directory, 'doc'), resolve(destination, 'rust'), { recursive: true });
  const python = process.env.PYTHON ?? resolve(root, 'python/.venv/bin/python');
  // Use this checkout even when PYTHON points at an editable installation in
  // another directory. pydoc is part of the standard library.
  const pythonModules = JSON.parse(execFileSync(python, ['-c', `import importlib, json, pydoc, sys
sys.path.insert(0, sys.argv[1])
names = ['dialcache', 'dialcache.cache', 'dialcache.config', 'dialcache.key', 'dialcache.serializer', 'dialcache.redis', 'dialcache.protocol', 'dialcache.metrics', 'dialcache.clock', 'dialcache.errors']
print(json.dumps({name: pydoc.render_doc(importlib.import_module(name), renderer=pydoc.plaintext) for name in names}))
`, resolve(root, 'python')], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
  mkdirSync(resolve(destination, 'python'), { recursive: true });
  writeFileSync(resolve(destination, 'python/index.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DialCache Python API</title><style>body{font:16px/1.6 system-ui;margin:2rem auto;padding:0 1rem;max-width:80rem}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px}a{color:#3451b2}@media(prefers-color-scheme:dark){body{background:#1b1b1f;color:#dfdfd6}a{color:#a8b1ff}}</style></head>
<body><nav><a href="../../api.html">All languages</a> · <a href="../../languages/python.html">Python guide</a></nav>
<h1>DialCache Python API</h1><p>Generated with <code>pydoc</code> from <a href="${source('python')}">${revision.slice(0, 7)}</a>. Use your browser's Find command to locate a symbol.</p>
<ul>${Object.keys(pythonModules).map(name => `<li><a href="#${name}">${name}</a></li>`).join('')}</ul>
${Object.entries(pythonModules).map(([name, text]) => `<section><h2 id="${name}">${name}</h2><pre>${escape(text)}</pre></section>`).join('\n')}</body></html>\n`);
  writeFileSync(resolve(destination, 'revision.json'), JSON.stringify({ revision }, null, 2) + '\n');
}

const inventory = JSON.parse(readFileSync(resolve(root, 'formal/semantic-cases.json'), 'utf8'));
const profiles = JSON.parse(readFileSync(resolve(root, 'formal/profiles.json'), 'utf8'));
const md = text => escape(text).replaceAll('|', '&#124;').replaceAll('\n', ' ');
const link = (label, path) => `[${md(label)}](${source(path)})`;
const models = new Map();
const modelLink = ref => {
  const [path, name] = ref.split(':');
  if (!models.has(path)) {
    const text = readFileSync(resolve(root, path), 'utf8');
    models.set(path, { text, declarations: scanDeclarationBodies(text) });
  }
  const { text, declarations } = models.get(path);
  // The scanner skips comments and references. Anchor inside the definition,
  // including when its signature spans several lines.
  const offset = declarations.get(name)?.spans[0]?.[0];
  if (offset === undefined) throw new Error(`Missing Quint declaration: ${ref}`);
  const line = text.slice(0, offset).split('\n').length;
  return link(name, `${path}#L${line}`);
};
const pages = ['---', 'editLink: false', '---', '', '# Behavior catalogue', '',
  'Generated from the reviewed [semantic case inventory](' + source('formal/semantic-cases.json') + '). ' + inventory.scope, '',
  'These links describe registered evidence and its scope. They are not a fresh test result or a claim of exhaustive coverage. ' +
  'See the [validation guide](' + source('formal/VALIDATION.md') + ') for how a completed run is established.', '',
  'All supported ports replay the shared histories through their native drivers. ' +
  [link('TypeScript replay tests', 'typescript/test/formal-features.test.ts'), link('Go replay tests', 'go/feature_replay_test.go'), link('Rust replay tests', 'rust/tests/conformance.rs'), link('Python replay tests', 'python/tests/test_conformance.py')].join(' · ') + '.', '',
  '| Case | Behavior | Model and regression evidence | Shared replay evidence |',
  '| --- | --- | --- | --- |'];
for (const item of inventory.cases) {
  const models = (item.models ?? []).map(entry => `${modelLink(entry.ref)}: ${md(entry.scope)}`).join('<br>');
  const generated = (item.generated ?? []).map(entry => {
    const profile = profiles.profiles.find(profile => profile.id === entry.profile);
    return `${link(entry.profile, profile?.model ?? 'formal/profiles.json')} / ${md(entry.witness)}`;
  });
  const replays = (item.quintReplays ?? []).map(ref => md(ref));
  const vectors = (item.vectors ?? []).map(ref => md(typeof ref === 'string' ? ref : JSON.stringify(ref)));
  pages.push(`| <a id="${item.id.toLowerCase()}"></a>${md(item.id)} | ${md(item.rule)} | ${models} | ${[...generated, ...replays, ...vectors].join('<br>')} |`);
}
mkdirSync(resolve(root, 'docs/generated'), { recursive: true });
writeFileSync(resolve(root, 'docs/generated/behavior.md'), pages.join('\n') + '\n');
console.log(`Generated ${inventory.cases.length} documented behavioral cases at ${revision.slice(0, 7)}.`);
