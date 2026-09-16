import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
// The kernel library's concern modules live in one directory; every tool that
// needs to know that asks here.
export const kernelDirectory = 'formal/kernel';
export const isKernelSource = path => path.startsWith(`${kernelDirectory}/`);
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

// The checkpoint of a reproducer is the one top-level `.expect(...)` in the
// cited run's chain whose condition is the declared `failure` text, compared
// token by token so spacing does not matter. Returns the chain before that
// expect and the chain through it. Run as probes under the fault, the first
// must still pass and the second must fail: the failure then belongs to the
// declared expectation, not to a step the fault disables or a later check.
const opens = ['{', '(', '['], shuts = ['}', ')', ']'];
export function reproducerCheckpoint(source, run, failure) {
  const declaration = scanDeclarationBodies(source).get(run);
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
function validateReproducer(challenge, model, { models, libraries, profileIds, publicOnly, readSource }) {
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
  try { reproducerCheckpoint(readSource(cited.path), run, failure); }
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

// Challenges that predate the reproducer requirement. The backlog may only
// shrink: a new challenge must carry a reproducer, and listing it here instead
// is a reviewed change to this constant, never a manifest edit.
export const grandfatheredReproducerBacklog = Object.freeze([
  'source-deadline-epoch',
  'recovery-inclusive-maximum',
  'recovery-future-candidate',
  'legacy-recovery-inclusive-maximum',
  'local-precise-grid',
  'source-inclusive-deadline',
  'fence-inclusive-timestamp',
  'profile-source-wrong-clock',
  'profile-source-wrong-owner',
  'profile-recovery-wrong-snapshot',
  'recovery-read-wrong-admission-policy',
  'legacy-recovery-wrong-snapshot',
  'independent-wrong-admission-policy',
  'independent-wrong-recovered-value',
  'effects-source-wrong-clock',
  'effects-wrong-acceptance-receipt',
  'legacy-recovery-strands-followers',
  'independent-source-wrong-clock',
  'independent-source-wrong-owner',
  'tracked-read-inclusive-fence',
  'policy-inclusive-remote-freshness',
  'core-unhealthy-local-read-hits',
  'core-tracked-fallback-warms-local',
  'runtime-policy-coalesce-defaults-off',
  'runtime-policy-physical-ttl-ignores-recovery',
  'stale-recovery-inclusive-served-maximum',
  'stale-recovery-candidate-stamped-at-read',
  'shadow-validation-fenced-fill-writes',
  'shadow-validation-fill-before-source',
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
  'effects-fenced-source-publishes',
  'effects-late-source-accepted',
  'scope-late-source-repopulates-closed-memo',
  'scope-source-error-memoized',
  'admission-duplicate-key-admitted',
  'layers-process-flight-crosses-instance',
  'layers-late-memo-into-closed-scope',
  'independent-fresh-frame-retained',
  'independent-deadline-settles-at-start',
  'recovery-read-inclusive-maximum',
  'recovery-read-recovery-warms-local',
  'local-failure-write-fault-publishes',
  'local-failure-source-error-published',
  'runtime-boundaries-inclusive-cohort',
  'runtime-boundaries-inherited-sharing-ignores-default',
  'shadow-layers-inclusive-c0-freshness',
  'shadow-layers-fill-uses-current-retention',
  'local-clock-hit-renews-insertion',
  'source-budgets-outside-call-has-deadline',
  'source-budgets-settled-flight-stays-registered',
]);

// Compiling semantic faults, checked against independent model obligations.
// Every scheduled model carries at least one challenge or an explicit waiver.
// Every challenge carries a reproducer or is listed in the reported backlog.
function validateChallenges(manifest, { readSource, contracts, sources, profileIds, publicOnly, grandfathered = grandfatheredReproducerBacklog }) {
  const { challenges, reproducerBacklog } = manifest;
  if (!Array.isArray(challenges) || !challenges.length) throw new Error('Model property challenge catalog is missing');
  if (!Array.isArray(reproducerBacklog)) throw new Error('Challenge reproducer backlog is missing');
  const models = new Map(manifest.models.map(model => [model.path, model]));
  const fields = ['id', 'contract', 'source', 'model', 'invariant', 'before', 'after'];
  const optional = ['measures', 'reproducer'];
  const ids = new Set(), faults = new Map(), challengedModels = new Set();
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
    if (readSource(challenge.source).split(challenge.before).length !== 2) throw new Error(`${challenge.id}: mutation anchor must match exactly once in ${challenge.source}`);
    const fault = JSON.stringify([challenge.source, challenge.before, challenge.after]);
    if (faults.has(fault) && !nonEmptyText(challenge.measures)) {
      throw new Error(`${challenge.id}: repeats the fault of ${faults.get(fault)} without a measures note`);
    }
    if (challenge.measures !== undefined && (!nonEmptyText(challenge.measures) || !faults.has(fault))) {
      throw new Error(`${challenge.id}: a measures note is only for a repeated fault`);
    }
    if (!faults.has(fault)) faults.set(fault, challenge.id);
    challengedModels.add(challenge.model);
    if (challenge.reproducer !== undefined) {
      validateReproducer(challenge, model, { models, libraries: manifest.libraries, profileIds, publicOnly, readSource });
      reproducers++;
    }
  }
  // The backlog is the exact set of challenges without a reproducer: it can be
  // reported, and it cannot hide a challenge that has one or never existed.
  const backlog = new Set(reproducerBacklog);
  if (backlog.size !== reproducerBacklog.length) throw new Error('Duplicate challenge ids in reproducerBacklog');
  for (const id of backlog) {
    if (!ids.has(id)) throw new Error(`reproducerBacklog names an unknown challenge: ${id}`);
  }
  const grandfatheredIds = new Set(grandfathered);
  for (const challenge of challenges) {
    const listed = backlog.has(challenge.id);
    if (challenge.reproducer !== undefined && listed) throw new Error(`${challenge.id}: has a reproducer and is listed in reproducerBacklog`);
    if (challenge.reproducer === undefined && !listed) throw new Error(`${challenge.id}: has no reproducer and is not listed in reproducerBacklog`);
    if (listed && !grandfatheredIds.has(challenge.id)) throw new Error(`${challenge.id}: new challenges must carry a reproducer; reproducerBacklog only grandfathers the challenges that predate the requirement`);
  }
  const waived = [];
  for (const model of manifest.models) {
    if (model.challengeWaiver !== undefined) {
      if (!nonEmptyText(model.challengeWaiver) || challengedModels.has(model.path)) throw new Error(`${model.path}: challenge waiver must explain an unchallenged model`);
      waived.push(model.path);
    } else if (!challengedModels.has(model.path)) {
      throw new Error(`${model.path}: scheduled invariants have no model property challenge and no challengeWaiver`);
    }
  }
  return { challenges: challenges.length, distinctFaults: faults.size, challengedModels: challengedModels.size, waivedModels: waived.length,
    reproducers, reproducerBacklog: backlog.size };
}

export function validateExecution(manifest = readExecution(), {
  readSource = read,
  grandfathered = grandfatheredReproducerBacklog,
  files = quintSources(),
  profiles = JSON.parse(read('formal/profiles.json')).profiles,
  contracts = contractIds(read('formal/CONTRACTS.md')),
} = {}) {
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.models) || !manifest.models.length ||
      !Array.isArray(manifest.libraries)) throw new Error('Unsupported model execution manifest');
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
  // kernel library's concern modules, at formal/kernel/. Kernel modules are
  // never scheduled on their own: a composed profile executes them, and a
  // fault in one is measured through the profiles that compose it.
  const paths = [...manifest.models.map(model => model.path), ...manifest.libraries];
  if (manifest.models.some(model => typeof model.path !== 'string' || !/^formal\/[\w-]+\.qnt$/.test(model.path)) ||
      manifest.libraries.some(path => typeof path !== 'string' || !/^formal\/[\w-]+\.qnt$/.test(isKernelSource(path) ? `formal/${path.slice(kernelDirectory.length + 1)}` : path)) ||
      new Set(paths).size !== paths.length || !sameMembers(paths, files)) throw new Error('Model/library file inventory changed; review the execution schedule');
  const profileIds = [], outputDirectories = new Set([check.outputDirectory]), publicOnly = new Map();
  let invariants = 0, regressions = 0, generatedTraces = 0;
  let exportedRegressionTraces = 0, generatedVectors = 0, vectorModels = 0;
  const vectorPaths = new Set();
  for (const model of manifest.models) {
    const bodies = scanDeclarationBodies(readSource(model.path));
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
    names(model.regressions, `${model.path} regressions`, true);
    const declaredRuns = [...declarations].filter(([, kind]) => kind === 'run').map(([name]) => name);
    if (model.regressions.some(name => !name.endsWith('Test')) || !sameMembers(model.regressions, declaredRuns)) {
      throw new Error(`${model.path}: regression schedule must exactly name every run and retain the Test suffix`);
    }
    invariants += model.invariants.length;
    regressions += model.regressions.length;
    if (model.propertyChallenge !== undefined) throw new Error(`${model.path}: property challenges live in the manifest challenges catalog`);
    // A composed profile's differential knobs: bumping behaviorVersion declares
    // an intended change of observable behavior (the differential then does
    // not compare that profile against the reference revision), and
    // maxBytesPerStateRatio is the trace-size growth the profile may take.
    if (model.differential !== undefined) {
      if (!model.differential || typeof model.differential !== 'object' || Array.isArray(model.differential) || model.generate === undefined) throw new Error(`${model.path}: unsupported differential settings`);
      const keys = Object.keys(model.differential);
      if (!keys.length || keys.some(key => !['behaviorVersion', 'maxBytesPerStateRatio'].includes(key))) throw new Error(`${model.path}: unsupported differential settings`);
      const { behaviorVersion, maxBytesPerStateRatio } = model.differential;
      if (behaviorVersion !== undefined && (!Number.isSafeInteger(behaviorVersion) || behaviorVersion < 1)) throw new Error(`${model.path}: differential.behaviorVersion must be a positive integer`);
      if (maxBytesPerStateRatio !== undefined && (typeof maxBytesPerStateRatio !== 'number' || !(maxBytesPerStateRatio >= 1))) throw new Error(`${model.path}: differential.maxBytesPerStateRatio must be at least 1`);
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
    if (model.replayRegressions !== undefined) {
      names(model.replayRegressions, `${model.path} replay regressions`);
      exportedRegressionTraces += model.replayRegressions.length;
      if (!model.profile || declarations.get('input') !== 'var' ||
          model.replayRegressions.some(name => !model.regressions.includes(name))) throw new Error(`${model.path}: replay regressions need declared input and scheduled tests`);
    }
    if (model.profile !== undefined) {
      // Every deterministic history a driver could replay must be exported, and
      // an exported history must never patch model state behind the driver.
      const runs = classifyRuns(bodies);
      publicOnly.set(model.path, runs.publicOnly);
      const exported = new Set(model.replayRegressions ?? []);
      const unexported = runs.publicOnly.filter(name => !exported.has(name));
      const patched = runs.patching.filter(name => exported.has(name));
      if (unexported.length) throw new Error(`${model.path}: public-only runs are not exported as replay regressions: ${unexported.join(', ')}`);
      if (patched.length) throw new Error(`${model.path}: state-patching runs cannot be replay regressions: ${patched.join(', ')}`);
    }
    if (model.vectorExport !== undefined) {
      const vector = model.vectorExport;
      if (model.profile !== undefined || !['protocol', 'invalidation'].includes(vector.kind)
        || !/^formal\/generate-[\w-]+-vectors\.mjs$/.test(vector.generator)
        || !/^formal\/quint-[\w-]+-vectors\.json$/.test(vector.artifact)
        || !Array.isArray(vector.sources) || new Set(vector.sources).size !== vector.sources.length
        || !vector.sources.includes(model.path) || !vector.sources.includes(vector.generator)
        || vector.sources.some(path => path !== model.path && path !== vector.generator && !manifest.libraries.includes(path))) {
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
  for (const path of manifest.libraries) {
    const declarations = scanDeclarations(readSource(path));
    if ([...declarations.values()].some(kind => ['action', 'run', 'var'].includes(kind))) throw new Error(`${path}: a stateful model cannot be classified as a pure helper library`);
  }
  if (!sameMembers(profileIds, profiles.map(profile => profile.id))) throw new Error('Generated profile inventory differs from claim registry');
  const challenges = validateChallenges(manifest, { readSource, contracts, sources: new Set(paths), profileIds: new Set(profileIds), publicOnly, grandfathered });
  return { models: manifest.models.length, libraries: manifest.libraries.length, profiles: profileIds.length, invariants, regressions, generatedTraces, exportedRegressionTraces, vectorModels, generatedVectors, ...challenges };
}

// Call after validateExecution: coverage links must name checks that run, not
// merely declarations that happen to exist in a model or a comment.
export function scheduledProperties(manifest) {
  return new Set(manifest.models.flatMap(model => [...model.invariants, ...model.regressions].map(name => `${model.path}:${name}`)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(validateExecution(process.argv.includes('--stdin')
    ? JSON.parse(readFileSync(0, 'utf8')) : undefined), null, 2));
}
