import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkDocsLinks, checkDocsSources } from './check-docs.mjs';

test('rejects missing regions instead of letting VitePress silently show the whole file', t => {
  const root = mkdtempSync(join(tmpdir(), 'dialcache-docs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'docs/languages'), { recursive: true });
  const ports = ['typescript', 'go', 'rust'].map(id => ({ id, guide: `/languages/${id}`, example: `${id}.txt` }));
  writeFileSync(join(root, 'docs/ports.json'), JSON.stringify(ports));
  for (const port of ports) {
    writeFileSync(join(root, `docs${port.guide}.md`), '# Install\n');
    writeFileSync(join(root, port.example), '// #region scope\nreal_code();\n// #endregion scope\n');
  }
  const section = id => `<LanguageContent language="${id}">\n\n<<< @/../${id}.txt#scope\n\n</LanguageContent>\n`;
  writeFileSync(join(root, 'docs/concepts.md'), ports.map(port => section(port.id)).join('\n'));
  assert.deepEqual(checkDocsSources(root), { ports: 3, imports: 3 });
  writeFileSync(join(root, 'rust.txt'), 'code_without_the_named_region();\n');
  assert.throws(() => checkDocsSources(root), /missing, duplicate or unclosed region/);
  writeFileSync(join(root, 'rust.txt'), '// #region scope\nreal_code();\n// #endregion scope\n');
  writeFileSync(join(root, 'docs/concepts.md'), section('typescript') + section('go'));
  assert.throws(() => checkDocsSources(root), /scope missing rust/);
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
