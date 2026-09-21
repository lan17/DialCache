import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
// The kernel library's concern modules live in one directory; every tool that
// needs to know that asks here.
export const kernelDirectory = 'formal/kernel';
export const isKernelSource = path => path.startsWith(`${kernelDirectory}/`);
// Where a Quint source may live: formal/ for models and helper libraries,
// formal/kernel/ for the kernel library's modules, no deeper.
export const isQuintSourcePath = path => /^formal\/(kernel\/)?[\w-]+\.qnt$/.test(path);
// Every Quint source a model may import: the scheduled models and helper
// libraries at formal/ and the kernel library modules at formal/kernel/.
export function quintSources(directory = root) {
  const files = [];
  for (const relative of ['formal', kernelDirectory]) {
    const absolute = resolve(directory, relative);
    if (!existsSync(absolute)) continue;
    for (const name of readdirSync(absolute)) if (name.endsWith('.qnt')) files.push(`${relative}/${name}`);
  }
  return files.sort();
}
// A model's import closure: its own text and every Quint source it reaches
// through relative imports, in dependency order. What a model's behavior
// depends on, so tools that hash, compare or classify a model walk it here.
export function importClosure(path, directory = root) {
  const closure = [];
  const visit = source => {
    if (closure.includes(source) || !existsSync(resolve(directory, source))) return;
    closure.push(source);
    for (const [, target] of readFileSync(resolve(directory, source), 'utf8').matchAll(/from\s+"(\.\.?\/[^"]+)"/g)) {
      visit(posix.normalize(posix.join(posix.dirname(source), `${target}.qnt`)));
    }
  };
  visit(path);
  return closure;
}
// Copy every Quint source of one tree into another, keeping the formal/ layout
// so relative imports resolve there as they do in the repository.
export function copySources(from, to) {
  const files = quintSources(from);
  for (const path of files) {
    mkdirSync(resolve(to, dirname(path)), { recursive: true });
    copyFileSync(resolve(from, path), resolve(to, path));
  }
  return files;
}
const read = path => readFileSync(root + path, 'utf8');
export const readExecution = () => JSON.parse(read('formal/execution.json'));

// A scoped declaration scanner, not a Quint parser or typechecker. Ignore
// comments, keep each string literal as one opaque token, and only inventory
// declarations directly in the one module body. Quint remains responsible for
// syntax, types, and effects. Every token keeps its source span so a run body
// can be sliced back out of the text.
function tokenize(source) {
  const tokens = [], spans = [];
  const push = (text, start, end) => { tokens.push(text); spans.push([start, end]); };
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 2);
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated Quint comment');
      i = end + 2;
      continue;
    }
    if (source[i] === '"') {
      const start = i;
      let closed = false;
      for (i++; i < source.length; i++) {
        if (source[i] === '\\') { i++; continue; }
        if (source[i] === '"') { i++; closed = true; break; }
      }
      if (!closed) throw new Error('Unterminated Quint string');
      push(source.slice(start, i), start, i);
      continue;
    }
    const identifier = /^[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(i));
    if (identifier) { push(identifier[0], i, i + identifier[0].length); i += identifier[0].length; }
    else { push(source[i], i, i + 1); i++; }
  }
  return { tokens, spans };
}

// Top-level declarations with their token bodies. A body runs from the
// declaration name to the next top-level declaration keyword; module imports
// and other non-declaration statements never attach to a declaration body.
// `spans` holds the source range of each body token.
export function scanDeclarationBodies(source) {
  const { tokens, spans } = tokenize(source);
  const declarations = new Map(), stack = [];
  const kinds = new Set(['val', 'def', 'action', 'run', 'type', 'var', 'const', 'assume']);
  const closes = { '}': '{', ')': '(', ']': '[' };
  let modules = 0, current;
  if (tokens[0] !== 'module') throw new Error('Expected a Quint module declaration');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!stack.length && i > 2) throw new Error('Unexpected content outside the Quint module');
    if (!stack.length && token === 'module') {
      if (!/^[A-Za-z_]\w*$/.test(tokens[i + 1] ?? '') || tokens[i + 2] !== '{') {
        throw new Error('Unsupported Quint module declaration');
      }
      modules++;
    }
    if (stack.length === 1 && stack[0] === '{' && kinds.has(token)) {
      const name = tokens[i + 1];
      if (!name || !/^[A-Za-z_]\w*$/.test(name)) throw new Error(`Unsupported Quint ${token} declaration`);
      if (declarations.has(name)) throw new Error(`Duplicate Quint declaration: ${name}`);
      current = { kind: token, body: [], spans: [] };
      declarations.set(name, current);
      i++;
      continue;
    }
    if (stack.length === 1 && stack[0] === '{' && token === 'pure') { current = undefined; continue; }
    if (stack.length === 1 && stack[0] === '{' && ['import', 'export'].includes(token)) current = undefined;
    if (stack.length >= 1 && current && !(stack.length === 1 && token === '}')) { current.body.push(token); current.spans.push(spans[i]); }
    if (['{', '(', '['].includes(token)) stack.push(token);
    else if (Object.hasOwn(closes, token) && stack.pop() !== closes[token]) throw new Error('Unbalanced Quint delimiters');
  }
  if (stack.length || modules !== 1) throw new Error('Expected one balanced Quint module');
  return declarations;
}

export function scanDeclarations(source) {
  return new Map([...scanDeclarationBodies(source)].map(([name, { kind }]) => [name, kind]));
}

// Replay classification for profile models. A run is public-only when every
// transition it takes records an external command in `input`. A body patches
// state when it assigns `s'` without recording a public command, keeps `input`
// unchanged across a state assignment, or calls the shadow fixture patcher.
const assigns = (body, variable) => body.some((token, i) =>
  token === variable && body[i + 1] === "'" && body[i + 2] === '=' && body[i + 3] !== '=');
function patchesDirectly(kind, body) {
  if (body.some((token, i) => token === 'input' && body[i + 1] === "'" && body[i + 2] === '=' && body[i + 3] === 'input') ||
      body.includes('modelFixture')) return true;
  return assigns(body, 's') && (kind === 'run' || !assigns(body, 'input'));
}
export function classifyRuns(declarations) {
  const patching = new Map();
  const resolve = (name, trail = new Set()) => {
    if (patching.has(name)) return patching.get(name);
    if (trail.has(name)) return false;
    trail.add(name);
    const { kind, body } = declarations.get(name);
    const result = patchesDirectly(kind, body) ||
      body.some(token => token !== name && declarations.has(token) &&
        ['action', 'def', 'val', 'run'].includes(declarations.get(token).kind) && resolve(token, trail));
    patching.set(name, result);
    return result;
  };
  const runs = { publicOnly: [], patching: [] };
  for (const [name, { kind }] of declarations) {
    if (kind === 'run') (resolve(name) ? runs.patching : runs.publicOnly).push(name);
  }
  return runs;
}

// The schedule a model's text states, read off its declarations rather than
// listed in the manifest. Every run a model declares is a scheduled
// regression, in declaration order. A profile model exports its public-only
// runs as replay regressions, so what the ports replay is exactly what the
// text lets them replay; its state-patching runs stay model-only.
export function modelSchedule(model, bodies) {
  const regressions = [...bodies].filter(([, { kind }]) => kind === 'run').map(([name]) => name);
  return model.profile === undefined ? { regressions } : { regressions, replayRegressions: classifyRuns(bodies).publicOnly };
}
// Every Quint source no scheduled model claims is a helper library, in the
// sorted order quintSources lists them.
export function libraryPaths(manifest, files = quintSources()) {
  const claimed = new Set(manifest.models.map(model => model.path));
  return files.filter(path => !claimed.has(path));
}
// The manifest with its schedule: `libraries`, and each model's `regressions`
// and (for a profile model) `replayRegressions`. Tools that run, export or
// account for the schedule read it through here; the manifest carries only
// what a person decides. Validate the manifest first (validateExecution).
export function scheduleExecution(manifest = readExecution(), { readSource = read, scanSource = scanDeclarationBodies, files = quintSources() } = {}) {
  return { ...manifest, libraries: libraryPaths(manifest, files),
    models: manifest.models.map(model => ({ ...model, ...modelSchedule(model, scanSource(readSource(model.path))) })) };
}

// The checkpoint of a reproducer is the one top-level `.expect(...)` in the
// cited run's chain whose condition is the declared `failure` text, compared
// token by token so spacing does not matter. Returns the chain before that
// expect and the chain through it. Run as probes under the fault, the first
// must still pass and the second must fail: the failure then belongs to the
// declared expectation, not to a step the fault disables or a later check.
const opens = ['{', '(', '['], shuts = ['}', ')', ']'];
export function reproducerCheckpoint(source, run, failure, declarations = scanDeclarationBodies(source)) {
  const declaration = declarations.get(run);
  if (declaration?.kind !== 'run') throw new Error(`${run} is not a run declaration`);
  const { body, spans } = declaration;
  const wanted = tokenize(typeof failure === 'string' ? failure : '').tokens;
  if (!wanted.length || body[0] !== '=' || body.length < 2) throw new Error(`${run}: reproducer failure must be an expect condition`);
  for (let depth = 0, i = 1; i < body.length; i++) {
    if (depth === 0 && body[i] === '(' && body[i - 1] === 'expect' && body[i - 2] === '.') {
      const condition = [];
      let j = i + 1;
      for (let nested = 1; nested > 0; j++) {
        if (j >= body.length) throw new Error(`${run}: unbalanced expect`);
        if (opens.includes(body[j])) nested++;
        else if (shuts.includes(body[j])) nested--;
        if (nested > 0) condition.push(body[j]);
      }
      if (condition.length === wanted.length && condition.every((token, index) => token === wanted[index])) {
        const start = spans[1][0];
        return { before: source.slice(start, spans[i - 2][0]).trimEnd(), through: source.slice(start, spans[j - 1][1]) };
      }
      i = j - 1;
      continue;
    }
    if (opens.includes(body[i])) depth++;
    else if (shuts.includes(body[i])) depth--;
  }
  throw new Error(`${run} has no top-level expect whose condition is the declared failure`);
}

// Count states in the supported deterministic action-chain syntax, then turn
// that count into a zero-based ITF checkpoint. Expectations add no state;
// literal repetitions add every transition they execute. This deliberately
// refuses an unfamiliar expression instead of assigning it an approximate
// index: the challenge can supply reviewed written evidence in that case.
export function checkpointStep(before, declarations) {
  const refuse = detail => { throw new Error(`Cannot derive boundary checkpoint: ${detail}; write nativeMutants.evidence`); };
  const matching = (tokens, start) => {
    const close = shuts[opens.indexOf(tokens[start])];
    let depth = 1;
    for (let i = start + 1; i < tokens.length; i++) {
      if (tokens[i] === tokens[start]) depth++;
      else if (tokens[i] === close && --depth === 0) return i;
    }
    return refuse('unbalanced action expression');
  };
  const add = (a, b) => {
    const count = a + b;
    if (!Number.isSafeInteger(count)) refuse('checkpoint exceeds safe integer range');
    return count;
  };
  function count(tokens, trail = new Set()) {
    while (tokens[0] === '(' && matching(tokens, 0) === tokens.length - 1) tokens = tokens.slice(1, -1);
    if (!tokens.length) return refuse('empty action expression');
    const chain = [];
    for (let i = 0; i < tokens.length; i++) {
      if (opens.includes(tokens[i])) { i = matching(tokens, i); continue; }
      if (tokens[i] === '.' && ['then', 'expect'].includes(tokens[i + 1])) {
        if (tokens[i + 2] !== '(') return refuse('unrecognized chain operator');
        const end = matching(tokens, i + 2);
        chain.push({ start: i, end, method: tokens[i + 1], argument: tokens.slice(i + 3, end) });
        i = end;
      }
    }
    if (chain.length) {
      let total = count(tokens.slice(0, chain[0].start), trail);
      let end = chain[0].start - 1;
      for (const part of chain) {
        if (part.start !== end + 1) return refuse('unsupported expression between chain steps');
        if (part.method === 'then') total = add(total, count(part.argument, trail));
        end = part.end;
      }
      if (end !== tokens.length - 1) return refuse('unsupported action-chain suffix');
      return total;
    }
    const dot = tokens.indexOf('.');
    if (dot > 0 && tokens[dot + 1] === 'reps' && tokens[dot + 2] === '(' && matching(tokens, dot + 2) === tokens.length - 1) {
      const literal = tokens.slice(0, dot).join('');
      if (!/^\d+$/.test(literal) || !Number.isSafeInteger(Number(literal))) return refuse('repetition count must be a safe integer literal');
      const lambda = tokens.slice(dot + 3, -1);
      if (!/^[A-Za-z_]\w*$/.test(lambda[0] ?? '') || lambda[1] !== '=' || lambda[2] !== '>') return refuse('unsupported repetition lambda');
      const repeated = Number(literal) * count(lambda.slice(3), trail);
      if (!Number.isSafeInteger(repeated)) return refuse('repetition count exceeds safe integer range');
      return repeated;
    }
    const name = tokens[0];
    const declaration = declarations.get(name);
    if (!declaration || !['action', 'run'].includes(declaration.kind)) return refuse(`unknown action ${name}`);
    if (trail.has(name)) return refuse(`cyclic action alias ${name}`);
    if (tokens.length !== 1 && !(tokens[1] === '(' && matching(tokens, 1) === tokens.length - 1)) return refuse(`unsupported action expression ${name}`);
    const body = declaration.body;
    let equals = -1;
    for (let i = 0; i < body.length; i++) {
      if (opens.includes(body[i])) { i = matching(body, i); continue; }
      if (body[i] === '=') { equals = i; break; }
    }
    if (equals < 0) return refuse(`action ${name} has no body`);
    const rhs = body.slice(equals + 1);
    const sequences = rhs.some((token, i) => token === '.' && ['then', 'reps'].includes(rhs[i + 1]));
    if (['all', 'any', '{'].includes(rhs[0])) {
      if (sequences) return refuse(`nested action sequence in ${name}`);
      // An atomic wrapper must not hide a multi-state action behind an alias.
      for (const [index, token] of rhs.entries()) {
        if (rhs[index - 1] === ':' || rhs[index - 1] === '.' || rhs[index + 1] === ':') continue;
        if (declarations.get(token)?.kind === 'action' && count([token], new Set([...trail, name])) !== 1) {
          return refuse(`nested action sequence in ${name}`);
        }
      }
      return 1;
    }
    return count(rhs, new Set([...trail, name]));
  }
  const states = count(tokenize(before).tokens);
  if (states < 1) refuse('history has no initial state');
  return states - 1;
}

const observationFields = new Set(['calls', 'loaders', 'reads', 'loads', 'dumps', 'writes', 'policyCalls', 'invalidations',
  'classifications', 'comparisons', 'maintenance', 'recovery', 'shadow', 'sourceScopes', 'writeTtls']);
const effectsFields = new Set(['calls', 'loaders', 'reads', 'loads', 'dumps', 'writes', 'policyCalls', 'invalidations',
  'writeTtls', 'events', 'readContexts', 'readAborts']);
function boundaryField(profile, field) {
  if (profile === 'effects' || profile === 'local-clock') {
    if (field.startsWith('o.')) field = field.slice(2);
    if (profile === 'effects') field = ({ 'io.budgets': 'readContexts', 'io.aborted': 'readAborts' })[field] ?? field;
    return (profile === 'effects' ? effectsFields : observationFields).has(field) ? field : undefined;
  }
  return /^(o|d|io)\.\w+$/.test(field) || /^(markers|compression|policyErrors)$/.test(field) ? field : undefined;
}

// Fields name the actual assertion record, rather than the model's private
// state. The two flat replay bindings (effects and local-clock) are explicit;
// feature profiles retain their channel prefix. Tests cross-check these paths
// against the bindings without making the manifest validator import replay.
export function evidenceOf(challenge, models, publicOnly, { readSource = read, scanSource = scanDeclarationBodies } = {}) {
  const native = challenge.nativeMutants;
  if (native?.kind !== 'mapped') return undefined;
  const base = { challenge: challenge.id, mutant: native.mutant };
  const model = models.get(challenge.reproducer?.model ?? challenge.model);
  if (!model) throw new Error(`${challenge.id}: boundary evidence model is not scheduled`);
  const reproducer = challenge.reproducer;
  const written = native.evidence;
  if (reproducer?.kind !== 'exported-regression') {
    if (written !== undefined) throw new Error(`${challenge.id}: written boundary evidence requires an exported-regression reproducer`);
    return { ...base, state: model.vectorExport && reproducer?.kind === 'model-run' ? 'vector' : 'unreproduced' };
  }
  if (!model.profile || !publicOnly.get(model.path)?.includes(reproducer.run)) throw new Error(`${challenge.id}: boundary evidence requires an exported public-only history`);
  const history = `${model.profile}/${reproducer.run}`;
  if (written !== undefined) {
    if (!written || typeof written !== 'object' || Array.isArray(written) ||
      Object.keys(written).some(key => !['history', 'step', 'fields'].includes(key))) throw new Error(`${challenge.id}: invalid written boundary evidence`);
    if (written.history !== history) throw new Error(`${challenge.id}: evidence history must equal the reproducer history ${history}`);
    if (!Number.isSafeInteger(written.step) || written.step < 1) throw new Error(`${challenge.id}: evidence step must be a positive integer`);
    if (!Array.isArray(written.fields) || !written.fields.length || new Set(written.fields).size !== written.fields.length ||
      written.fields.some(field => typeof field !== 'string' || boundaryField(model.profile, field) !== field)) {
      throw new Error(`${challenge.id}: evidence fields must be nonempty unique public assertion paths for ${model.profile}`);
    }
    return { ...base, history, step: written.step, fields: [...written.fields], origin: 'written' };
  }
  const source = readSource(model.path), declarations = scanSource(source);
  const checkpoint = reproducerCheckpoint(source, reproducer.run, reproducer.failure, declarations);
  const tokens = tokenize(reproducer.failure).tokens;
  const fields = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 's' || tokens[i + 1] !== '.') continue;
    const channel = tokens[i + 2];
    // A private field can share a public name (effects' reads/loaders lists).
    // Only the public channels, plus the explicitly compared root channels,
    // contribute evidence; flat paths are produced by projection below.
    if (!['o', 'd', 'io', 'events', 'markers', 'compression', 'policyErrors'].includes(channel)) continue;
    const raw = ['o', 'd', 'io'].includes(channel) && tokens[i + 3] === '.'
      ? `${channel}.${tokens[i + 4]}` : channel;
    const field = boundaryField(model.profile, raw);
    if (field && !fields.includes(field)) fields.push(field);
  }
  if (!fields.length) throw new Error(`${challenge.id}: checkpoint has no derived public fields; write nativeMutants.evidence`);
  const step = checkpointStep(checkpoint.before, declarations);
  if (step < 1) throw new Error(`${challenge.id}: boundary evidence checkpoint must follow initialization`);
  return { ...base, history, step, fields, origin: 'derived' };
}

export function boundaryEvidence(manifest = readExecution(), { readSource = read, scanSource = scanDeclarationBodies } = {}) {
  const sources = new Map(), declarations = new Map();
  const source = path => { if (!sources.has(path)) sources.set(path, readSource(path)); return sources.get(path); };
  const scanned = text => { if (!declarations.has(text)) declarations.set(text, scanSource(text)); return declarations.get(text); };
  const models = new Map(manifest.models.map(model => [model.path, model]));
  const publicOnly = new Map(manifest.models.filter(model => model.profile).map(model => [model.path, classifyRuns(scanned(source(model.path))).publicOnly]));
  return manifest.challenges.flatMap(challenge => {
    const evidence = evidenceOf(challenge, models, publicOnly, { readSource: source, scanSource: scanned });
    return evidence === undefined ? [] : [evidence];
  });
}

const positiveInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid positive bound: ${label}`);
};
const names = (values, label, allowEmpty = false) => {
  if (!Array.isArray(values) || (!allowEmpty && !values.length) ||
      values.some(name => typeof name !== 'string' || !/^[A-Za-z_]\w*$/.test(name)) ||
      new Set(values).size !== values.length) throw new Error(`Invalid ${label} inventory`);
};
const sameMembers = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
const nonEmptyText = value => typeof value === 'string' && value.trim().length > 0;
const isSlug = value => typeof value === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value);
export const contractIds = text => [...text.matchAll(/^\| ([CWEB]\d{2}) \|/gm)].map(match => match[1]);

// A deterministic reproducer pins one challenge to a named run that passes on
// the clean model and fails, at one declared expectation, under the fault. An
// exported-regression cites a public-only run both ports replay, so the fault
// is portable behavior; for a fault in a shared library (a helper library or a
// kernel module) the run may live in a profile model other than the challenged
// one, since every importer executes the mutated text. A model-run cites a run that only the model executes and
// must say why the fault has no native counterpart. `failure` is the expect
// condition the fault breaks. `profiles` names where the fault is observable:
// the challenged model's own profile, or its path for a model without one,
// and the cited run's profile. `exclusions` explains why a known profile that
// is not listed cannot exercise the fault. A shared-library fault must list or
// exclude every profile; a fault in one model's own file needs no exclusions,
// because no other profile executes that text.
const reproducerKinds = ['exported-regression', 'model-run'];
const reproducerFields = ['kind', 'run', 'model', 'failure', 'family', 'profiles', 'exclusions', 'scope'];
function validateReproducer(challenge, model, { models, libraries, profileIds, publicOnly, source, scanned }) {
  const { id, reproducer } = challenge;
  if (!reproducer || typeof reproducer !== 'object' || Array.isArray(reproducer)) throw new Error(`${id}: invalid reproducer`);
  const unknown = Object.keys(reproducer).filter(key => !reproducerFields.includes(key));
  if (unknown.length) throw new Error(`${id}: unsupported reproducer field ${unknown.join(', ')}`);
  const { kind, run, failure, family, profiles, exclusions, scope } = reproducer;
  if (!reproducerKinds.includes(kind)) throw new Error(`${id}: reproducer kind must be one of ${reproducerKinds.join(', ')}`);
  const shared = libraries.includes(challenge.source);
  const cited = reproducer.model === undefined ? model : models.get(reproducer.model);
  if (reproducer.model !== undefined && (!cited?.profile || kind !== 'exported-regression' || !shared || cited === model)) {
    throw new Error(`${id}: reproducer model must name another profile model and is allowed only for an exported-regression of a shared-library fault: ${reproducer.model}`);
  }
  if (typeof run !== 'string' || !cited.regressions.includes(run)) throw new Error(`${id}: reproducer run is not a scheduled regression of ${cited.path}: ${run}`);
  if (!nonEmptyText(failure)) throw new Error(`${id}: reproducer failure must state the expect condition the fault breaks`);
  try { reproducerCheckpoint(source(cited.path), run, failure, scanned(cited.path)); }
  catch (error) { throw new Error(`${id}: ${error.message}`); }
  if (!isSlug(family)) throw new Error(`${id}: reproducer family must be a fault family slug`);
  const own = model.profile ?? model.path;
  const required = [...new Set([own, ...(cited.profile ? [cited.profile] : [])])];
  if (!Array.isArray(profiles) || !profiles.length || new Set(profiles).size !== profiles.length ||
      required.some(name => !profiles.includes(name)) || profiles.some(profile => profile !== own && !profileIds.has(profile))) {
    throw new Error(`${id}: reproducer profiles must name known profiles and include ${required.join(' and ')}`);
  }
  if (!exclusions || typeof exclusions !== 'object' || Array.isArray(exclusions)) throw new Error(`${id}: reproducer exclusions must map profiles to reasons`);
  for (const [profile, reason] of Object.entries(exclusions)) {
    if (!profileIds.has(profile) || profiles.includes(profile) || !nonEmptyText(reason)) {
      throw new Error(`${id}: reproducer exclusion must name an unlisted known profile with a reason: ${profile}`);
    }
  }
  if (shared) {
    const unaccounted = [...profileIds].filter(profile => !profiles.includes(profile) && !Object.hasOwn(exclusions, profile));
    if (unaccounted.length) throw new Error(`${id}: a shared-library fault must list or exclude every profile; missing ${unaccounted.join(', ')}`);
  }
  const exported = cited.replayRegressions?.includes(run) ?? false;
  if (kind === 'exported-regression') {
    if (!cited.profile || !exported || !publicOnly.get(cited.path)?.includes(run)) {
      throw new Error(`${id}: exported-regression reproducer must cite an exported public-only run of ${cited.path}: ${run}`);
    }
    if (scope !== undefined) throw new Error(`${id}: scope belongs only to a model-run reproducer`);
  } else {
    if (exported) throw new Error(`${id}: ${run} is exported; cite it as an exported-regression reproducer`);
    if (!nonEmptyText(scope)) throw new Error(`${id}: model-run reproducer needs a scope stating why the fault has no native counterpart`);
  }
}

// Every challenge names the native mutant that injects its fault into both
// ports, or explains why none exists. `mapped`: the mutant's TypeScript and Go
// sections both require generated detection, so the weekly lanes fail if the
// corpus stops detecting it in either port. `unobservable`: a port line
// exists, but the port checks the same condition again at a later point, so
// no public history distinguishes the fault; the text names the line and the
// later check. `model-only`: the fault rewrites model bookkeeping no port line
// carries; the text names the port code it examined. `crossContract` is the
// one reason a mapped mutant may sit on a semantic case that does not list
// the challenge's contract. The challenge text says why the mutant is the same
// fault as the model's; the port-side account lives once on the catalog entry.
export const nativeMutantKinds = ['mapped', 'unobservable', 'model-only'];
const nativeMutantFields = ['kind', 'text', 'mutant', 'crossContract', 'evidence'];
const nativeMutantTextLimits = { mapped: 500, unobservable: 900, 'model-only': 900 };

// One catalog of native mutants, each entry a fault described once and
// injected into both ports: `typescript` and `go` sections hold that port's
// exact-anchor edits and required detections. One id grammar serves the
// catalog, the measurers and --only.
export const mutantCatalogPath = 'formal/mutations.json';
export const mutantIdPattern = /^M\d{2,}$/;
// Where a port's edits may point and which cohorts its detections may require.
export const mutantPorts = {
  typescript: { label: 'TypeScript', edit: /^src\/[\w/-]+\.ts$/, cohorts: ['ordinary', 'generated', 'portable'] },
  go: { label: 'Go', edit: /^go\/[\w-]+\.go$/, cohorts: ['ordinary', 'generated', 'fixed', 'portable'] },
};
const mutantFields = ['id', 'case', 'description', 'rationale', 'typescript', 'go'];

// The catalog's schema: ids, cases, descriptions, the rationale that carries
// the port-side account, and both ports' sections with edits inside their
// port and known cohorts. Anchors are checked separately (checkMutantAnchors),
// so validating the manifest never depends on src/ or go/ text.
export function readMutantCatalog(readText = read) {
  const refuse = detail => { throw new Error(`Mutant catalog: ${detail}`); };
  const caseContracts = new Map(JSON.parse(readText('formal/semantic-cases.json')).cases.map(entry => [entry.id, entry.contracts]));
  const parsed = JSON.parse(readText(mutantCatalogPath));
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.mutations) || !parsed.mutations.length) refuse(`expected the versioned catalog ${mutantCatalogPath}`);
  const mutations = new Map();
  for (const mutation of parsed.mutations) {
    const { id } = mutation;
    if (typeof id !== 'string' || !mutantIdPattern.test(id) || mutations.has(id)) refuse(`invalid or duplicate mutant id ${id}`);
    const unknown = Object.keys(mutation).filter(key => !mutantFields.includes(key));
    if (unknown.length) refuse(`${id} has unsupported field ${unknown.join(', ')}`);
    if (!caseContracts.has(mutation.case)) refuse(`${id} cites unknown case ${mutation.case}`);
    if (!nonEmptyText(mutation.description)) refuse(`${id} has no description`);
    if (!nonEmptyText(mutation.rationale)) refuse(`${id} has no rationale naming the port lines it edits`);
    for (const [port, { label, edit: editPath, cohorts }] of Object.entries(mutantPorts)) {
      const section = mutation[port];
      if (!section || typeof section !== 'object' || Array.isArray(section)) refuse(`${id} has no ${label} section`);
      const extra = Object.keys(section).filter(key => !['edits', 'requiredDetections'].includes(key));
      if (extra.length) refuse(`${id} ${label} section has unsupported field ${extra.join(', ')}`);
      if (!Array.isArray(section.requiredDetections) || section.requiredDetections.some(cohort => !cohorts.includes(cohort))) refuse(`${id} requires an unknown ${label} cohort`);
      if (!Array.isArray(section.edits) || !section.edits.length) refuse(`${id} has no ${label} edits`);
      for (const edit of section.edits) {
        if (typeof edit?.path !== 'string' || !editPath.test(edit.path) || edit.path.endsWith('_test.go')) refuse(`${id} edits ${edit?.path} outside the ${label} port`);
        if (!nonEmptyText(edit.before) || typeof edit.after !== 'string' || edit.before === edit.after) refuse(`${id} has an empty or unchanged edit in ${edit.path}`);
      }
    }
    mutations.set(id, mutation);
  }
  return { mutations, caseContracts };
}

// The port view of a catalog entry: what one measurer applies and gates.
export function mutantsForPort(catalog, port) {
  return [...catalog.mutations.values()].map(mutation => ({ id: mutation.id, case: mutation.case, description: mutation.description, ...mutation[port] }));
}

// Every anchor still matches the port text exactly once when the entry's
// edits are applied in order, so a refactor that moves an anchored line fails
// the audit, the pull request's test suite and the measurers, never the Quint
// lanes. Returns the original text of every edited file, which the measurers
// restore after each mutant. `readText` reads a repository-relative path, so
// a measurement checks its workspace copy.
export function checkMutantAnchors(catalog, readText = read) {
  const sources = new Map();
  const source = path => { if (!sources.has(path)) sources.set(path, readText(path)); return sources.get(path); };
  for (const mutation of catalog.mutations.values()) {
    for (const port of Object.keys(mutantPorts)) {
      const texts = new Map();
      for (const edit of mutation[port].edits) {
        const current = texts.get(edit.path) ?? source(edit.path);
        if (current.split(edit.before).length !== 2) throw new Error(`Mutant anchor drift: ${mutation.id}: anchor must match exactly once in ${edit.path}; review the ${mutantPorts[port].label} port or the catalog`);
        texts.set(edit.path, current.replace(edit.before, () => edit.after));
      }
    }
  }
  return sources;
}

const portPath = /\b(?:src|go)\/[\w./-]+/;
function validateNativeMutants(challenge, { catalog, models, publicOnly, source, scanned }) {
  const { id, nativeMutants: native } = challenge;
  if (!native || typeof native !== 'object' || Array.isArray(native)) throw new Error(`${id}: invalid nativeMutants`);
  const unknown = Object.keys(native).filter(key => !nativeMutantFields.includes(key));
  if (unknown.length) throw new Error(`${id}: unsupported nativeMutants field ${unknown.join(', ')}`);
  const { kind, text, mutant, crossContract } = native;
  if (!nativeMutantKinds.includes(kind)) throw new Error(`${id}: nativeMutants kind must be one of ${nativeMutantKinds.join(', ')}`);
  if (!nonEmptyText(text)) throw new Error(`${id}: nativeMutants text must say why the mutant is the same fault or explain why none exists`);
  // The text carries the why; the where lives on the catalog entry. A ceiling
  // keeps the port-side account from creeping back into every citing challenge.
  if (text.length > nativeMutantTextLimits[kind]) throw new Error(`${id}: nativeMutants text exceeds ${nativeMutantTextLimits[kind]} characters; the port-side account belongs in the mutant's rationale`);
  if (kind !== 'mapped') {
    if (mutant !== undefined || crossContract !== undefined || native.evidence !== undefined) throw new Error(`${id}: ${kind} nativeMutants name no mutant or evidence`);
    // An explanation names the port code it examined, so a reader can check it.
    if (!portPath.test(text)) throw new Error(`${id}: ${kind} nativeMutants text must name the port file it examined`);
    return;
  }
  if (typeof mutant !== 'string') throw new Error(`${id}: mapped nativeMutants need a mutant id`);
  const entry = catalog.mutations.get(mutant);
  if (!entry) throw new Error(`${id}: ${mutant} is not in the mutant catalog`);
  if (!text.includes(mutant)) throw new Error(`${id}: nativeMutants text must name ${mutant}`);
  if (!Object.keys(mutantPorts).every(port => entry[port].requiredDetections.includes('generated'))) throw new Error(`${id}: ${mutant} must require generated detection in both ports`);
  const outside = !catalog.caseContracts.get(entry.case).includes(challenge.contract);
  if (outside && !nonEmptyText(crossContract)) throw new Error(`${id}: ${mutant} is on case ${entry.case} which does not list ${challenge.contract}; add a crossContract reason`);
  if (!outside && crossContract !== undefined) throw new Error(`${id}: crossContract note for in-contract mutant ${mutant}`);
  return evidenceOf(challenge, models, publicOnly, {
    readSource: source, scanSource: () => scanned(challenge.reproducer?.model ?? challenge.model),
  });
}

// Challenges that predate the native-mutant requirement. The cutoff fault
// lives only in the Lua invalidation script (src/internal/redis-scripts.ts,
// go/redis_adapter.go), which no in-process cohort executes. The buffer-limit
// fault has client-side lines in both ports (src/internal/duration.ts
// assertSupportedFutureBufferMs, go/cache.go Invalidate), but no generated
// history invalidates with the maximum buffer, so a mapped mutant would lack
// its required detection; it closes when a profile exposes the buffer as an
// input and an exported regression reaches the bound. The list may only
// shrink: a new challenge maps to a native mutant or explains why none exists,
// and listing it here instead is a reviewed change to this constant, never a
// manifest edit.
export const grandfatheredNativeMutantBacklog = Object.freeze([
  'invalidation-transition-cutoff-moves-backwards',
  'invalidation-transition-inclusive-buffer-limit',
]);

// Which challenges cite each mutant, in manifest order. The mutation reports
// print it beside every measured mutant.
export function challengesByMutant(manifest) {
  const index = new Map();
  for (const challenge of manifest.challenges) {
    const mutant = challenge.nativeMutants?.mutant;
    if (mutant === undefined) continue;
    if (!index.has(mutant)) index.set(mutant, []);
    index.get(mutant).push(challenge.id);
  }
  return index;
}

// A backlog is the exact set of challenges lacking one field, reported and
// frozen: it cannot hide a challenge that has the field or never existed, and
// only the grandfathered ids may sit in it, so it only shrinks.
function validateBacklog(challenges, ids, { name, listed, present, grandfathered, missing, has, lacks, requirement }) {
  if (!Array.isArray(listed)) throw new Error(missing);
  const backlog = new Set(listed);
  if (backlog.size !== listed.length) throw new Error(`Duplicate challenge ids in ${name}`);
  for (const id of backlog) {
    if (!ids.has(id)) throw new Error(`${name} names an unknown challenge: ${id}`);
  }
  const frozen = new Set(grandfathered);
  for (const challenge of challenges) {
    const inBacklog = backlog.has(challenge.id);
    if (present(challenge) && inBacklog) throw new Error(`${challenge.id}: ${has} and is listed in ${name}`);
    if (!present(challenge) && !inBacklog) throw new Error(`${challenge.id}: ${lacks} and is not listed in ${name}`);
    if (inBacklog && !frozen.has(challenge.id)) throw new Error(`${challenge.id}: ${requirement}; ${name} only grandfathers the challenges that predate the requirement`);
  }
  return backlog.size;
}

// Challenges that predate the reproducer requirement. The backlog may only
// shrink: a new challenge must carry a reproducer, and listing it here instead
// is a reviewed change to this constant, never a manifest edit.
export const grandfatheredReproducerBacklog = Object.freeze([
  'recovery-inclusive-maximum',
  'recovery-future-candidate',
  'local-precise-grid',
  'source-inclusive-deadline',
  'profile-source-wrong-clock',
  'profile-source-wrong-owner',
  'independent-wrong-recovered-value',
  'independent-source-wrong-clock',
  'independent-source-wrong-owner',
  'core-unhealthy-local-read-hits',
  'core-tracked-fallback-warms-local',
  'runtime-policy-coalesce-defaults-off',
  'runtime-policy-physical-ttl-ignores-recovery',
  'stale-recovery-inclusive-served-maximum',
  'stale-recovery-candidate-stamped-at-read',
  'redis-protocol-inclusive-fence',
  'redis-protocol-untracked-fence',
  'frame-vectors-inclusive-fence',
  'invalidation-transition-cutoff-moves-backwards',
  'invalidation-transition-inclusive-buffer-limit',
  'key-protocol-untracked-brace-rejection',
  'cohort-inclusive-threshold',
  'envelope-vectors-tie-compresses',
  'envelope-vectors-escape-misses-binary-marker',
  'conformance-local-hit-returns-source',
  'conformance-remote-miss-skips-publication',
  'scope-late-source-repopulates-closed-memo',
  'layers-late-memo-into-closed-scope',
  'independent-fresh-frame-retained',
  'runtime-boundaries-inclusive-cohort',
  'runtime-boundaries-inherited-sharing-ignores-default',
  'source-budgets-outside-call-has-deadline',
  'source-budgets-settled-flight-stays-registered',
]);

// Compiling semantic faults, checked against independent model obligations.
// Every scheduled model carries at least one challenge or an explicit waiver.
// Every challenge carries a reproducer or is listed in the reported backlog,
// and maps to native mutants in both ports or is listed in that backlog.
function validateChallenges(manifest, { source, scanned, contracts, sources, profileIds, publicOnly, catalog,
  grandfathered = grandfatheredReproducerBacklog, grandfatheredNative = grandfatheredNativeMutantBacklog }) {
  const { challenges, reproducerBacklog, nativeMutantBacklog } = manifest;
  if (!Array.isArray(challenges) || !challenges.length) throw new Error('Model property challenge catalog is missing');
  const models = new Map(manifest.models.map(model => [model.path, model]));
  const fields = ['id', 'contract', 'source', 'model', 'invariant', 'before', 'after'];
  const optional = ['measures', 'reproducer', 'nativeMutants'];
  const ids = new Set(), faults = new Map(), challengedModels = new Set();
  const kinds = { mapped: 0, unobservable: 0, 'model-only': 0 };
  const boundary = { derived: 0, written: 0, unreproduced: 0, vector: 0 };
  let reproducers = 0;
  for (const challenge of challenges) {
    if (!challenge || typeof challenge !== 'object' || fields.some(key => typeof challenge[key] !== 'string' || !challenge[key])) {
      throw new Error(`Invalid model property challenge: ${JSON.stringify(challenge)}`);
    }
    const unknown = Object.keys(challenge).filter(key => !fields.includes(key) && !optional.includes(key));
    if (unknown.length) throw new Error(`${challenge.id}: unsupported challenge field ${unknown.join(', ')}`);
    if (!isSlug(challenge.id) || ids.has(challenge.id)) throw new Error(`Invalid or duplicate challenge id: ${challenge.id}`);
    ids.add(challenge.id);
    if (!contracts.includes(challenge.contract)) throw new Error(`${challenge.id}: unknown contract ${challenge.contract}`);
    if (!sources.has(challenge.source)) throw new Error(`${challenge.id}: mutation source is not a scheduled model or library: ${challenge.source}`);
    const model = models.get(challenge.model);
    if (!model) throw new Error(`${challenge.id}: challenged model is not scheduled: ${challenge.model}`);
    if (!model.invariants.includes(challenge.invariant)) throw new Error(`${challenge.id}: ${challenge.invariant} is not a scheduled invariant of ${challenge.model}`);
    if (challenge.before === challenge.after) throw new Error(`${challenge.id}: mutation must change the source`);
    if (source(challenge.source).split(challenge.before).length !== 2) throw new Error(`${challenge.id}: mutation anchor must match exactly once in ${challenge.source}`);
    const fault = JSON.stringify([challenge.source, challenge.before, challenge.after]);
    if (faults.has(fault) && !nonEmptyText(challenge.measures)) {
      throw new Error(`${challenge.id}: repeats the fault of ${faults.get(fault).id} without a measures note`);
    }
    if (challenge.measures !== undefined && (!nonEmptyText(challenge.measures) || !faults.has(fault))) {
      throw new Error(`${challenge.id}: a measures note is only for a repeated fault`);
    }
    challengedModels.add(challenge.model);
    if (challenge.reproducer !== undefined) {
      validateReproducer(challenge, model, { models, libraries: manifest.libraries, profileIds, publicOnly, source, scanned });
      reproducers++;
    }
    if (challenge.nativeMutants !== undefined) {
      const evidence = validateNativeMutants(challenge, { catalog, models, publicOnly, source, scanned });
      if (evidence) boundary[evidence.origin ?? evidence.state]++;
      kinds[challenge.nativeMutants.kind]++;
    }
    // One fault, one native mapping: a repeated fault measured against another
    // invariant names the same kind and mutant. The text and any crossContract
    // reason speak for the challenge's own contract and may differ.
    const native = challenge.nativeMutants === undefined ? null
      : JSON.stringify([challenge.nativeMutants.kind, challenge.nativeMutants.mutant ?? null]);
    if (faults.has(fault) && faults.get(fault).native !== native) throw new Error(`${challenge.id}: maps the fault of ${faults.get(fault).id} differently`);
    if (!faults.has(fault)) faults.set(fault, { id: challenge.id, native });
  }
  const reproducerBacklogSize = validateBacklog(challenges, ids, { name: 'reproducerBacklog', listed: reproducerBacklog, present: challenge => challenge.reproducer !== undefined,
    grandfathered, missing: 'Challenge reproducer backlog is missing', has: 'has a reproducer', lacks: 'has no reproducer', requirement: 'new challenges must carry a reproducer' });
  const nativeBacklogSize = validateBacklog(challenges, ids, { name: 'nativeMutantBacklog', listed: nativeMutantBacklog, present: challenge => challenge.nativeMutants !== undefined,
    grandfathered: grandfatheredNative, missing: 'Challenge native-mutant backlog is missing', has: 'has nativeMutants', lacks: 'has no nativeMutants',
    requirement: 'new challenges must map to a native mutant in both ports or explain why none exists' });
  const waived = [];
  for (const model of manifest.models) {
    if (model.challengeWaiver !== undefined) {
      if (!nonEmptyText(model.challengeWaiver) || challengedModels.has(model.path)) throw new Error(`${model.path}: challenge waiver must explain an unchallenged model`);
      waived.push(model.path);
    } else if (!challengedModels.has(model.path)) {
      throw new Error(`${model.path}: scheduled invariants have no model property challenge and no challengeWaiver`);
    }
  }
  // Catalog mutants no challenge cites are reported, not gated: the catalog
  // may carry faults for rules the models do not challenge.
  const cited = challengesByMutant(manifest);
  const unmappedMutants = [...catalog.mutations.keys()].filter(id => !cited.has(id)).length;
  return { challenges: challenges.length, distinctFaults: faults.size, challengedModels: challengedModels.size, waivedModels: waived.length,
    reproducers, reproducerBacklog: reproducerBacklogSize,
    nativeMutants: { mapped: kinds.mapped, unobservable: kinds.unobservable, modelOnly: kinds['model-only'], backlog: nativeBacklogSize },
    boundaryEvidence: boundary, unmappedMutants };
}

export function validateExecution(manifest = readExecution(), {
  readSource = read,
  scanSource = scanDeclarationBodies,
  grandfathered = grandfatheredReproducerBacklog,
  grandfatheredNative = grandfatheredNativeMutantBacklog,
  catalog = readMutantCatalog(),
  files = quintSources(),
  profiles = JSON.parse(read('formal/profiles.json')).profiles,
  contracts = contractIds(read('formal/CONTRACTS.md')),
} = {}) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.models) || !manifest.models.length) throw new Error('Unsupported model execution manifest');
  // The schedule is read from the Quint text (modelSchedule, libraryPaths); a
  // manifest that lists it again is a copy the text would contradict.
  if (manifest.libraries !== undefined) throw new Error('libraries are read from the Quint sources: every source no scheduled model claims; delete the list');
  if (!Array.isArray(profiles) || !profiles.length || profiles.some(profile =>
    typeof profile.id !== 'string' || !/^[a-z][a-z-]*$/.test(profile.id)) ||
    new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Invalid execution profile IDs');
  const { settings, check, test } = manifest;
  if (!settings || settings.backend !== 'rust' || settings.threads !== 1 || settings.verbosity !== 1 ||
      typeof settings.seed !== 'string' || !/^(0x[\da-f]+|\d+)$/i.test(settings.seed)) throw new Error('Unsupported Quint execution settings');
  positiveInteger(check?.maxSamples, 'check.maxSamples');
  positiveInteger(check?.maxSteps, 'check.maxSteps');
  positiveInteger(test?.maxSamples, 'test.maxSamples');
  if (check.outputDirectory !== '.formal-traces/verification') throw new Error('Unsupported verification output directory');

  // Scheduled models live at formal/; helper libraries live there or, for the
  // kernel library's concern modules, at formal/kernel/, and are every Quint
  // source no model claims. Kernel modules are never scheduled on their own:
  // a composed profile executes them, and a fault in one is measured through
  // the profiles that compose it.
  const modelPaths = manifest.models.map(model => model.path);
  if (manifest.models.some(model => typeof model.path !== 'string' || !/^formal\/[\w-]+\.qnt$/.test(model.path)) ||
      new Set(modelPaths).size !== modelPaths.length || modelPaths.some(path => !files.includes(path))) throw new Error('Model/library file inventory changed; review the execution schedule');
  const libraries = libraryPaths(manifest, files);
  if (libraries.some(path => !isQuintSourcePath(path))) throw new Error('Model/library file inventory changed; review the execution schedule');
  const paths = [...modelPaths, ...libraries];
  // One pass reads and scans each source once: the model and library loops,
  // the challenge anchors and every reproducer checkpoint share these memos,
  // so a pass costs one scan per file rather than one per citation. They live
  // in the pass, not the module, because callers hand in temporary sources; a
  // caller validating many times may pass a `scanSource` memoized by text.
  const texts = new Map(), scans = new Map();
  const source = path => { if (!texts.has(path)) texts.set(path, readSource(path)); return texts.get(path); };
  const scanned = path => { if (!scans.has(path)) scans.set(path, scanSource(source(path))); return scans.get(path); };
  const profileIds = [], outputDirectories = new Set([check.outputDirectory]), publicOnly = new Map(), schedules = new Map();
  let invariants = 0, regressions = 0, generatedTraces = 0;
  let exportedRegressionTraces = 0, generatedVectors = 0, vectorModels = 0;
  const vectorPaths = new Set();
  for (const model of manifest.models) {
    const bodies = scanned(model.path);
    const declarations = new Map([...bodies].map(([name, { kind }]) => [name, kind]));
    if (declarations.get('init') !== 'action' || declarations.get('step') !== 'action') throw new Error(`${model.path}: scheduled model needs init and step actions`);
    names(model.invariants, `${model.path} invariants`);
    if (model.symbolic !== undefined) {
      if (manifest.symbolic?.backend !== 'apalache' || manifest.symbolic.version !== '0.56.1') throw new Error('Unsupported symbolic backend or version');
      if (manifest.symbolic.archive?.url !== 'https://github.com/apalache-mc/apalache/releases/download/v0.56.1/apalache-0.56.1.tgz'
        || !/^[a-f0-9]{64}$/.test(manifest.symbolic.archive.sha256)) throw new Error('Symbolic checking requires a versioned release archive and approved SHA-256');
      positiveInteger(model.symbolic.maxSteps, `${model.path} symbolic.maxSteps`);
      positiveInteger(model.symbolic.timeoutMs, `${model.path} symbolic.timeoutMs`);
    }
    for (const name of model.invariants) {
      if (declarations.get(name) !== 'val') throw new Error(`${model.path}: scheduled invariant is not a declared val: ${name}`);
    }
    if (model.regressions !== undefined || model.replayRegressions !== undefined) throw new Error(`${model.path}: regressions and replayRegressions are read from the model's runs; delete the lists`);
    const schedule = modelSchedule(model, bodies);
    const unsuffixed = schedule.regressions.filter(name => !name.endsWith('Test'));
    if (unsuffixed.length) throw new Error(`${model.path}: every run is a scheduled regression and must keep the Test suffix: ${unsuffixed.join(', ')}`);
    schedules.set(model.path, schedule);
    invariants += model.invariants.length;
    regressions += schedule.regressions.length;
    if (model.propertyChallenge !== undefined) throw new Error(`${model.path}: property challenges live in the manifest challenges catalog`);
    // A composed profile's declared behavior: bumping behaviorVersion says its
    // observable behavior changed on purpose, so the corpus differential
    // reports that profile instead of comparing it against the reference.
    // maxBytesPerStateRatio is the profile's own bound on trace growth for the
    // differential, in place of the lane's default: a composition that must
    // carry more state per trace than its predecessor declares it, with the
    // reason recorded in the kernel README's record table.
    if (model.differential !== undefined) {
      const settings = model.differential, known = ['behaviorVersion', 'maxBytesPerStateRatio'];
      if (!settings || typeof settings !== 'object' || Array.isArray(settings) || model.generate === undefined ||
          !Object.keys(settings).length || Object.keys(settings).some(key => !known.includes(key))) throw new Error(`${model.path}: unsupported differential settings`);
      const { behaviorVersion, maxBytesPerStateRatio } = settings;
      if (behaviorVersion !== undefined && (!Number.isSafeInteger(behaviorVersion) || behaviorVersion < 1)) throw new Error(`${model.path}: differential.behaviorVersion must be a positive integer`);
      if (maxBytesPerStateRatio !== undefined && (typeof maxBytesPerStateRatio !== 'number' || !Number.isFinite(maxBytesPerStateRatio) || maxBytesPerStateRatio < 1)) {
        throw new Error(`${model.path}: differential.maxBytesPerStateRatio must be a finite number of at least 1`);
      }
    }
    if (model.profile !== undefined || model.generate !== undefined) {
      const profile = profiles.find(profile => profile.id === model.profile);
      if (!profile || profile.model !== model.path || !model.generate) throw new Error(`${model.path}: generation profile differs from claim registry`);
      profileIds.push(model.profile);
      const generation = model.generate;
      for (const key of ['maxSamples', 'maxSteps', 'traces']) positiveInteger(generation[key], `${model.profile}.${key}`);
      if (generation.traces > generation.maxSamples) throw new Error(`${model.profile}: trace count exceeds sample bound`);
      // These are owned output directories: never permit traversal, a parent
      // directory, or reuse between profiles before recursive cleanup.
      const expectedDirectory = model.profile === 'core' ? '.formal-traces/conformance'
        : model.profile === 'effects' ? '.formal-traces/effects' : `.formal-traces/features/${model.profile}`;
      if (generation.outputDirectory !== expectedDirectory || outputDirectories.has(generation.outputDirectory)) throw new Error(`${model.profile}: unsafe or duplicate generation output directory`);
      outputDirectories.add(generation.outputDirectory);
      generatedTraces += generation.traces;
    }
    if (model.profile !== undefined) {
      // A profile records every public command in `input`; its public-only
      // runs are the histories both ports replay (modelSchedule), so a driver
      // can replay every deterministic history and never sees a patched state.
      if (declarations.get('input') !== 'var') throw new Error(`${model.path}: exported replay regressions need a declared input variable`);
      exportedRegressionTraces += schedule.replayRegressions.length;
      publicOnly.set(model.path, schedule.replayRegressions);
    }
    if (model.vectorExport !== undefined) {
      const vector = model.vectorExport;
      if (model.profile !== undefined || !['protocol', 'invalidation'].includes(vector.kind)
        || !/^formal\/generate-[\w-]+-vectors\.mjs$/.test(vector.generator)
        || !/^formal\/quint-[\w-]+-vectors\.json$/.test(vector.artifact)
        || !Array.isArray(vector.sources) || new Set(vector.sources).size !== vector.sources.length
        || !vector.sources.includes(model.path) || !vector.sources.includes(vector.generator)
        || vector.sources.some(path => path !== model.path && path !== vector.generator && !libraries.includes(path))) {
        throw new Error(`${model.path}: invalid vector export boundary`);
      }
      positiveInteger(vector.cases, `${model.path} vector cases`);
      if (vectorPaths.has(vector.generator) || vectorPaths.has(vector.artifact)) throw new Error('Duplicate vector generator or artifact');
      vectorPaths.add(vector.generator); vectorPaths.add(vector.artifact);
      generatedVectors += vector.cases;
      vectorModels++;
      for (const path of vector.sources) read(path);
    }
  }
  // A Quint source with actions, runs or state is a model: it runs only when
  // the manifest schedules it, so it may not sit unscheduled among the libraries.
  for (const path of libraries) {
    if ([...scanned(path).values()].some(({ kind }) => ['action', 'run', 'var'].includes(kind))) throw new Error(`${path}: a stateful Quint source must be a scheduled model; a helper library declares no actions, runs or state`);
  }
  // A library exists to be imported: one no scheduled model reaches, directly
  // or through another library, is never typechecked or executed by any lane,
  // so it may not stay in the tree. This is also the inventory tripwire: a
  // stray or half-deleted stateless source at formal/ is refused here rather
  // than admitted as a library by the directory listing.
  const reached = new Set(manifest.models.flatMap(model => importClosure(model.path)));
  const orphans = libraries.filter(path => !reached.has(path));
  if (orphans.length) throw new Error(`Quint libraries no scheduled model imports: ${orphans.join(', ')}; import them from a scheduled model or delete them`);
  if (!sameMembers(profileIds, profiles.map(profile => profile.id))) throw new Error('Generated profile inventory differs from claim registry');
  const scheduled = { ...manifest, libraries, models: manifest.models.map(model => ({ ...model, ...schedules.get(model.path) })) };
  const challenges = validateChallenges(scheduled, { source, scanned, contracts, sources: new Set(paths), profileIds: new Set(profileIds), publicOnly, catalog, grandfathered, grandfatheredNative });
  return { models: manifest.models.length, libraries: libraries.length, profiles: profileIds.length, invariants, regressions, generatedTraces, exportedRegressionTraces, vectorModels, generatedVectors, ...challenges };
}

// Over a scheduled manifest (scheduleExecution) after validateExecution:
// coverage links must name checks that run, not merely declarations that
// happen to exist in a model or a comment.
export function scheduledProperties(manifest) {
  return new Set(manifest.models.flatMap(model => [...model.invariants, ...model.regressions].map(name => `${model.path}:${name}`)));
}

// The audit entry point also anchors every catalog edit in the port text.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const summary = validateExecution(process.argv.includes('--stdin') ? JSON.parse(readFileSync(0, 'utf8')) : undefined);
  const catalog = readMutantCatalog();
  console.log(JSON.stringify({ ...summary, mutantAnchors: { mutants: catalog.mutations.size, files: checkMutantAnchors(catalog).size } }, null, 2));
}
