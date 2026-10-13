import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkDocsLinks, checkDocsSources, checkFormalLinks } from './check-docs.mjs';

test('catalogue evidence links land on test definitions rather than earlier comments', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  execFileSync(process.execPath, ['scripts/generate-docs.mjs', '--catalogue-only'], { cwd: root });
  const catalogue = readFileSync(join(root, 'docs/generated/behavior.md'), 'utf8');
  for (const [model, name] of [
    ['shadow', 'explicitInequalityRequiresConfirmationTest'],
    ['independent', 'staggeredSourceStartsKeepIndependentBudgetsTest'],
    ['local-failure', 'localReadFailureFallsThroughAndPreservesOldLocalTest'],
  ]) {
    const path = `formal/models/dialcache-${model}-conformance.qnt`;
    const link = catalogue.split('\n').find(line => line.includes(`[${name}](`));
    const target = link?.match(new RegExp(`\\[${name}\\]\\([^)]*#L(\\d+)\\)`));
    assert.ok(target, `${name}: missing source line link`);
    const definition = readFileSync(join(root, path), 'utf8').split('\n')[Number(target[1]) - 1];
    assert.ok(definition.trimStart().startsWith(`run ${name} =`), `${name}: linked to ${definition}`);
  }
});

test('rejects missing regions instead of letting VitePress silently show the whole file', t => {
  const root = mkdtempSync(join(tmpdir(), 'dialcache-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/languages'), { recursive: true });
  const ports = ['typescript', 'go', 'rust', 'python'].map(id => ({ id, guide: `/languages/${id}`, example: id === 'python' ? 'python.py' : `${id}.txt` }));
  writeFileSync(join(root, 'docs/ports.json'), JSON.stringify(ports));
  for (const port of ports) {
    writeFileSync(join(root, `docs${port.guide}.md`), '# Install\n');
    const marker = port.id === 'python' ? '# ' : '// #';
    writeFileSync(join(root, port.example), `${marker}region scope\nreal_code();\n${marker}endregion scope\n`);
  }
  const section = id => `<LanguageContent language="${id}">\n\n<<< @/../${ports.find(port => port.id === id).example}#scope\n\n</LanguageContent>\n`;
  writeFileSync(join(root, 'docs/concepts.md'), ports.map(port => section(port.id)).join('\n'));
  assert.deepEqual(checkDocsSources(root), { ports: 4, imports: 4 });
  writeFileSync(join(root, 'python.py'), '# #region scope\nreal_code()\n# #endregion scope\n');
  assert.throws(() => checkDocsSources(root), /missing, duplicate or unclosed region/);
  writeFileSync(join(root, 'python.py'), '# region scope\nreal_code()\n# endregion scope\n');
  writeFileSync(join(root, 'rust.txt'), 'code_without_the_named_region();\n');
  assert.throws(() => checkDocsSources(root), /missing, duplicate or unclosed region/);
  writeFileSync(join(root, 'rust.txt'), '// #region scope\nreal_code();\n// #endregion scope\n');
  writeFileSync(join(root, 'docs/concepts.md'), section('typescript') + section('go'));
  assert.throws(() => checkDocsSources(root), /scope missing rust/);
  writeFileSync(join(root, 'docs/concepts.md'), ports.filter(port => port.id !== 'python').map(port => section(port.id)).join('\n'));
  assert.throws(() => checkDocsSources(root), /scope missing python/);
  writeFileSync(join(root, 'docs/concepts.md'), section('typescript').replace('language="typescript"', 'language="ruby"'));
  assert.throws(() => checkDocsSources(root), /unknown language ruby/);
});

test('checks rendered anchors including native reference targets', t => {
  const root = mkdtempSync(join(tmpdir(), 'dialcache-doc-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = join(root, 'docs/.vitepress/dist');
  mkdirSync(join(out, 'reference/go'), { recursive: true });
  writeFileSync(join(out, 'reference/go/index.html'), '<h1 id="Cache">Cache</h1>');
  writeFileSync(join(out, 'index.html'), '<a href="/DialCache/reference/go/index.html#Cache" target="_self">API</a>');
  assert.deepEqual(checkDocsLinks(root), { pages: 1 });
  writeFileSync(join(out, 'index.html'), '<a href="/DialCache/reference/go/index.html#Cache">API</a>');
  assert.throws(() => checkDocsLinks(root), /bypass SPA routing/);
  writeFileSync(join(out, 'index.html'), '<a href="reference/go/index.html#Missing">API</a>');
  assert.throws(() => checkDocsLinks(root), /missing anchor/);
  writeFileSync(join(out, 'index.html'), '<a href="gone.html">Missing</a>');
  assert.throws(() => checkDocsLinks(root), /missing target/);
});

test('decodes escaped link and anchor attributes exactly once', t => {
  const root = mkdtempSync(join(tmpdir(), 'dialcache-doc-entities-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = join(root, 'docs/.vitepress/dist');
  mkdirSync(out, { recursive: true });
  // The href names the literal text &quot;, not the quote in this heading's ID.
  writeFileSync(join(out, 'index.html'), '<h1 id="literal&quot;">Quote</h1><a href="#literal&amp;quot;">Different anchor</a>');
  assert.throws(() => checkDocsLinks(root), /missing anchor/);
  writeFileSync(join(out, 'index.html'), '<h1 id="literal&amp;quot;">Literal entity</h1><a href="#literal&amp;quot;">Same anchor</a>');
  assert.deepEqual(checkDocsLinks(root), { pages: 1 });
  writeFileSync(join(out, 'index.html'), '<h1 id="literal&amp;quot;">Literal entity</h1><a href="#literal%26quot%3B">URL-encoded anchor</a>');
  assert.deepEqual(checkDocsLinks(root), { pages: 1 });
});

test('checks relative links in the formal guides and indexes and the repository READMEs', t => {
  const root = mkdtempSync(join(tmpdir(), 'dialcache-formal-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'formal/guides'), { recursive: true });
  mkdirSync(join(root, 'formal/models/kernel'), { recursive: true });
  writeFileSync(join(root, 'formal/guides/SPEC.md'), '# Spec\n\nSee [the kernel](../models/kernel/README.md#modules) and [the index](./README.md).\n');
  writeFileSync(join(root, 'formal/guides/README.md'), '# Guides\n\n- [SPEC.md](./SPEC.md)\n');
  writeFileSync(join(root, 'formal/models/kernel/README.md'), '# Kernel\n\n[rules](../cache-rules.qnt) and [replay](../../replay/)\n');
  writeFileSync(join(root, 'formal/models/cache-rules.qnt'), 'module cache_rules {}\n');
  mkdirSync(join(root, 'formal/replay'));
  writeFileSync(join(root, 'formal/README.md'), '# Formal\n\n| [guides/](./guides/) | [SPEC](./guides/SPEC.md) |\n\nA code span is ignored: \`[x](./nowhere.md)\` and so is https://example.invalid/x.md.\n');
  writeFileSync(join(root, 'README.md'), '# Repo\n\n[Quint specification](formal/README.md)\n');
  assert.deepEqual(checkFormalLinks(root), { pages: 5 });
  writeFileSync(join(root, 'formal/guides/README.md'), '# Guides\n\n- [SPEC.md](./SPEC.md)\n- [gone](./GONE.md#anchor)\n');
  assert.throws(() => checkFormalLinks(root), /formal\/guides\/README\.md: missing link target \.\/GONE\.md#anchor/);
  writeFileSync(join(root, 'formal/guides/README.md'), '# Guides\n\n- [SPEC.md](./SPEC.md)\n');
  writeFileSync(join(root, 'README.md'), '# Repo\n\n[Quint specification](formal/SPEC.md)\n');
  assert.throws(() => checkFormalLinks(root), /README\.md: missing link target formal\/SPEC\.md/);
});
