import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function files(directory, suffix, skip = []) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    skip.includes(entry.name) ? [] : entry.isDirectory()
      ? files(resolve(directory, entry.name), suffix, skip)
      : entry.name.endsWith(suffix) ? [resolve(directory, entry.name)] : []);
}

export function checkDocsSources(directory = root) {
  const docs = resolve(directory, 'docs');
  const ports = JSON.parse(readFileSync(resolve(docs, 'ports.json'), 'utf8'));
  const failures = [];
  const ids = ports.map(port => port.id);
  if (new Set(ids).size !== ids.length) failures.push('Duplicate documentation language');
  for (const port of ports) {
    for (const path of [port.example, `docs${port.guide}.md`]) {
      if (!existsSync(resolve(directory, path))) failures.push(`${port.id}: missing ${path}`);
    }
  }
  let imports = 0;
  for (const page of files(docs, '.md', ['.vitepress', 'public', 'generated'])) {
    const markdown = readFileSync(page, 'utf8');
    const regions = new Map();
    let selected;
    let fence;
    for (const [index, line] of markdown.split(/\r?\n/).entries()) {
      const at = `${relative(directory, page)}:${index + 1}`;
      // Ignore illustrative Markdown/source literals, including this syntax in
      // the authoring guide. They are not imports rendered by VitePress.
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker?.[0] === fence[0] && marker.length >= fence.length && /^\s*(`+|~+)\s*$/.test(line)) fence = undefined;
        continue;
      }
      if (marker) { fence = marker; continue; }
      const opening = /^<LanguageContent language="([^"]+)">\s*$/.exec(line);
      if (opening) {
        if (selected) failures.push(`${at}: nested language sections`);
        selected = opening[1];
        if (!ids.includes(selected)) failures.push(`${at}: unknown language ${selected}`);
      }
      if (/^<\/LanguageContent>\s*$/.test(line)) {
        if (!selected) failures.push(`${at}: unmatched language section close`);
        selected = undefined;
      }
      if (!line.startsWith('<<<')) continue;
      imports++;
      const match = /^<<<\s+([^\s#{}]+)#([\w-]+)(?:\s*\{[^}]+\})?\s*$/.exec(line);
      if (!match) { failures.push(`${at}: snippets require a file and named region`); continue; }
      const [, input, region] = match;
      const path = input.startsWith('@/') ? resolve(docs, input.slice(2)) : resolve(dirname(page), input);
      if (!existsSync(path) || !statSync(path).isFile()) { failures.push(`${at}: missing snippet ${input}`); continue; }
      const port = ports.find(port => resolve(directory, port.example) === path);
      if (!port) { failures.push(`${at}: snippet must use a registered, executed example file`); continue; }
      if (port.id !== selected) failures.push(`${at}: ${port.id} example requires its matching LanguageContent`);
      const code = readFileSync(path, 'utf8');
      const starts = [...code.matchAll(new RegExp(`^\\s*//\\s*#region ${region}\\s*$`, 'gm'))];
      const ends = [...code.matchAll(new RegExp(`^\\s*//\\s*#endregion ${region}\\s*$`, 'gm'))];
      if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index) failures.push(`${at}: missing, duplicate or unclosed region ${region} in ${input}`);
      if (!regions.has(region)) regions.set(region, new Set());
      regions.get(region).add(port.id);
    }
    if (selected) failures.push(`${relative(directory, page)}: unclosed language section`);
    // Native installation guides can show only their own example. A shared
    // feature scenario must teach the same thing in every supported port.
    if (!relative(docs, page).startsWith('languages/')) {
      for (const [region, seen] of regions) {
        const missing = ids.filter(id => !seen.has(id));
        if (missing.length) failures.push(`${relative(directory, page)}: ${region} missing ${missing.join(', ')}`);
      }
    }
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return { ports: ports.length, imports };
}

export function checkDocsLinks(directory = root) {
  const output = resolve(directory, 'docs/.vitepress/dist');
  const pages = files(output, '.html', ['assets', 'reference']);
  const failures = [];
  const idCache = new Map();
  // Decode one HTML layer, as the browser does. Chained replacements would
  // turn a literal &amp;quot; into a quote instead of preserving &quot;.
  const entities = { '&amp;': '&', '&quot;': '"', '&#39;': "'" };
  const decode = text => text.replace(/&(?:amp|quot|#39);/g, entity => entities[entity]);
  for (const page of pages) {
    const html = readFileSync(page, 'utf8');
    const pageUrl = new URL(relative(output, page), 'https://docs.invalid/DialCache/');
    for (const [, attributes] of html.matchAll(/<a\b([^>]+)>/g)) {
      const href = /\bhref="([^"]+)"/.exec(attributes)?.[1];
      if (href && new URL(decode(href), pageUrl).pathname.startsWith('/DialCache/reference/') && !/\btarget=/.test(attributes)) {
        failures.push(`${relative(output, page)}: native reference link requires target="_self" to bypass SPA routing: ${href}`);
      }
    }
    for (const [, raw] of html.matchAll(/\bhref="([^"]+)"/g)) {
      const href = decode(raw);
      const url = new URL(href, pageUrl);
      if (url.origin !== pageUrl.origin || !url.pathname.startsWith('/DialCache/')) continue;
      const path = decodeURIComponent(url.pathname.slice('/DialCache/'.length));
      const target = resolve(output, path.endsWith('/') || path === '' ? path + 'index.html' : path);
      if (!target.startsWith(output + '/') || !existsSync(target)) { failures.push(`${relative(output, page)}: missing target ${href}`); continue; }
      if (!url.hash || url.hash === '#' || !target.endsWith('.html')) continue;
      if (!idCache.has(target)) idCache.set(target, new Set([...readFileSync(target, 'utf8').matchAll(/\bid="([^"]+)"/g)].map(match => decode(match[1]))));
      if (!idCache.get(target).has(decodeURIComponent(url.hash.slice(1)))) failures.push(`${relative(output, page)}: missing anchor ${href}`);
    }
  }
  if (failures.length) throw new Error([...new Set(failures)].join('\n'));
  return { pages: pages.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(process.argv.includes('--links') ? checkDocsLinks() : checkDocsSources());
}
