#!/usr/bin/env node
// Dependency-following lint over Quint's parsed module IR (issue #165,
// evidence guarantee 6). `quint parse --out` yields the modules with their
// declarations and a lookup table that resolves every name and operator
// application to the declaration it refers to, across imports and instances.
// The lint builds the reference graph from that table and checks two rules:
//
// - Composition: from each action of the profile module, every value assigned
//   to a state variable other than the driver input is built from kernel
//   library transitions, record wiring, literals, constants and input
//   decoding. A comparison, branch, arithmetic or collection operator over
//   cache state, or a non-library definition applied to cache state, is rule
//   logic in the profile and is reported with the chain action -> helper ->
//   ... -> the definition that computes it. A lambda a profile hands to a
//   kernel definition is rule logic the library would run where the walk
//   cannot follow it (the kernel's own folds take their expiry only from
//   kernel modules), so it is reported at the call. profile-lint-baseline.json
//   records each profile's count: a composed profile has zero and the other
//   counts are the migration work list.
// - Witness isolation: no definition reachable from a cache guard, a cache
//   assignment, the profile's init or step, an input-choice domain (the
//   expression of a `nondet ... .oneOf()`), an observation projection (the
//   definition assigning the observation field), or the body of an operator
//   constant bound at instantiation may reference witness state. The witness
//   monitor's own assignment may read its prior state, so the value of an
//   assignment to a witness variable is not walked.
//
// Quint IR facts the walk relies on (verified against Quint 0.32.0): a
// parametrized definition is a `def` whose `expr` is a `lambda`; `x' = e` is an
// `app` with opcode `assign` and arguments `[name x, e]`; `nondet c = D.oneOf()`
// is a `let` whose `opdef` has qualifier `nondet`; `import M(C = e) as K` is an
// `instance` declaration with `overrides: [[{ name }, e]]`; `K::x` resolves to
// the proto module's own declaration id (with `importedFrom` attached);
// builtin operators and lambda parameters have no usable table entry; the
// table copies each declaration, so module attribution comes from
// `modules[].declarations`, never from the copy.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isKernelSource, quintSources } from './execution.mjs';
import { CommandFailure, runPool, spawnBuffered } from './quint-pool.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const baselinePath = 'formal/profile-lint-baseline.json';
export const defaultObservationField = 'o';
// The driver input every profile records; its assignment is the replay
// contract, not cache state, and may branch on state.
export const inputField = 'input';
const effectQualifiers = new Set(['action', 'run']);
// Builtin combinators whose non-effect operands are guards when the whole
// expression carries an effect: `all { guard, x' = e }`, `if (c) A else B`,
// and the scrutinee of `match c { | A => act1 | B => act2 }`.
const structuralOpcodes = new Set(['actionAll', 'actionAny', 'and', 'or', 'not', 'implies', 'iff', 'ite', 'matchVariant']);

// ---------------------------------------------------------------------------
// Parsing

export async function quintVersion({ cwd = root } = {}) {
  const result = await spawnBuffered('quint', ['--version'], { cwd, timeoutMs: 30_000 });
  if (result.error || result.status !== 0) throw new CommandFailure(`Cannot run quint --version: ${result.error?.message ?? result.stderr.trim()}`, result);
  return result.stdout.trim();
}

export async function parseModel(path, { cwd = root } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'profile-lint-'));
  const out = join(directory, 'parsed.json');
  try {
    const result = await spawnBuffered('quint', ['parse', path, '--out', out], { cwd, timeoutMs: 180_000 });
    if (result.error) throw new CommandFailure(`Cannot run quint parse ${path}: ${result.error.message}`, result);
    if (result.status !== 0 || !existsSync(out)) {
      throw new CommandFailure(`quint parse ${path} failed (exit ${result.status}):\n${result.stderr}${result.stdout}`, result);
    }
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    if (parsed.errors?.length) throw new Error(`quint parse ${path} reported errors: ${JSON.stringify(parsed.errors)}`);
    if (!Array.isArray(parsed.modules) || typeof parsed.table !== 'object') throw new Error(`quint parse ${path} produced no modules or lookup table`);
    return parsed;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Expression traversal

function* children(expr) {
  switch (expr.kind) {
    case 'app': yield* expr.args; return;
    case 'lambda': yield expr.expr; return;
    case 'let': yield expr.opdef.expr; yield expr.expr; return;
    default: return;
  }
}

function* nodes(expr) {
  if (!expr) return;
  yield expr;
  for (const child of children(expr)) yield* nodes(child);
}

function* nestedDefinitions(expr) {
  for (const node of nodes(expr)) if (node.kind === 'let') yield node.opdef;
}

// ---------------------------------------------------------------------------
// Indexing

// Graph nodes are the top-level definitions plus one pseudo-node per instance
// override (`K.PROJECT`), so a chain can show a reference that passes through
// a constant bound at instantiation.
export function indexModules(parsed, { main } = {}) {
  const modules = parsed.modules.map(module => module.name);
  if (!modules.length) throw new Error('Parsed output has no modules');
  const mainModule = main ?? modules.at(-1);
  if (!modules.includes(mainModule)) throw new Error(`Module ${mainModule} is not in the parsed set (${modules.join(', ')})`);
  const declarations = new Map();
  const graphNodes = new Map();
  const instances = [];
  const labelOf = (module, name) => module === mainModule ? name : `${module}::${name}`;
  const register = (declaration, module, owner) => {
    declarations.set(declaration.id, { id: declaration.id, kind: declaration.kind, name: declaration.name,
      qualifier: declaration.qualifier, module, owner, expr: declaration.expr });
  };
  for (const module of parsed.modules) {
    for (const declaration of module.declarations) {
      if (declaration.kind === 'instance') {
        const instanceLabel = labelOf(module.name, declaration.qualifiedName);
        const overrides = declaration.overrides.map(([parameter, expr]) => {
          const key = `override:${declaration.id}:${parameter.name}`;
          for (const nested of nestedDefinitions(expr)) register(nested, module.name, key);
          graphNodes.set(key, { key, kind: 'override', label: `${instanceLabel}.${parameter.name}`, module: module.name, expr,
            instance: declaration.qualifiedName, protoName: declaration.protoName, constant: parameter.name });
          return { name: parameter.name, key };
        });
        instances.push({ id: declaration.id, module: module.name, label: instanceLabel, qualifiedName: declaration.qualifiedName,
          protoName: declaration.protoName, overrides });
        continue;
      }
      if (declaration.kind !== 'def' && declaration.kind !== 'var' && declaration.kind !== 'const') continue;
      const key = String(declaration.id);
      register(declaration, module.name, key);
      if (declaration.kind !== 'def') continue;
      for (const nested of nestedDefinitions(declaration.expr)) register(nested, module.name, key);
      graphNodes.set(key, { key, kind: 'definition', label: labelOf(module.name, declaration.name), module: module.name,
        name: declaration.name, qualifier: declaration.qualifier, expr: declaration.expr, id: declaration.id });
    }
  }
  for (const [id, target] of Object.entries(parsed.table)) {
    if ((target.kind === 'def' || target.kind === 'var' || target.kind === 'const') && !declarations.has(target.id)) {
      throw new Error(`Lookup table entry ${id} resolves to undeclared ${target.kind} ${target.name} (id ${target.id})`);
    }
  }
  return { modules, main: mainModule, declarations, nodes: graphNodes, instances, table: parsed.table,
    tableSize: Object.keys(parsed.table).length, labelOf, effectCache: new Map() };
}

// The declaration a name or operator application resolves to; undefined for
// builtins, lambda parameters and type names.
function resolveTarget(index, expr) {
  if (expr.kind !== 'name' && expr.kind !== 'app') return undefined;
  const target = index.table[expr.id];
  return target ? index.declarations.get(target.id) : undefined;
}

const isVariable = declaration => declaration?.kind === 'var';
const variableLabel = (index, variable) => index.labelOf(variable.module, variable.name);

function overrideNodes(index, constant) {
  const result = [];
  for (const instance of index.instances) {
    if (instance.protoName !== constant.module) continue;
    for (const override of instance.overrides) if (override.name === constant.name) result.push(index.nodes.get(override.key));
  }
  return result;
}

// Graph nodes a node's body refers to, in traversal order: the owner of every
// resolved definition (let-bound definitions fold into their owner) and every
// override bound for a referenced constant.
function referencesOf(index, node) {
  const targets = [];
  const seen = new Set([node.key]);
  const push = target => { if (target && !seen.has(target.key)) { seen.add(target.key); targets.push(target); } };
  for (const expr of nodes(node.expr)) {
    const declaration = resolveTarget(index, expr);
    if (!declaration) continue;
    if (declaration.kind === 'def') push(index.nodes.get(declaration.owner));
    else if (declaration.kind === 'const') for (const override of overrideNodes(index, declaration)) push(override);
  }
  return targets;
}

function assignmentsOf(index, node) {
  const assignments = [];
  for (const expr of nodes(node.expr)) {
    if (expr.kind !== 'app' || expr.opcode !== 'assign') continue;
    const variable = resolveTarget(index, expr.args[0]);
    if (!isVariable(variable)) throw new Error(`Assignment ${expr.id} in ${node.label} does not resolve to a state variable`);
    assignments.push({ variable, value: expr.args[1] });
  }
  return assignments;
}

// Whether an expression assigns state or refers to an action: such an
// expression is a transition fragment, and its effect-free siblings under a
// structural combinator are guards.
function hasEffects(index, expr) {
  const cached = index.effectCache.get(expr.id);
  if (cached !== undefined) return cached;
  let result = false;
  if (expr.kind === 'app' && expr.opcode === 'assign') result = true;
  else {
    const declaration = resolveTarget(index, expr);
    if (declaration?.kind === 'def' && effectQualifiers.has(declaration.qualifier)) result = true;
    else for (const child of children(expr)) if (hasEffects(index, child)) { result = true; break; }
  }
  index.effectCache.set(expr.id, result);
  return result;
}

const compareStrings = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const topLevelDefinitions = index => [...index.nodes.values()].filter(node => node.kind === 'definition');

// ---------------------------------------------------------------------------
// Composition rule

// The profile's public actions are `init` and every action of the profile
// module that `step` refers to (the same rule generated-fixtures.mjs applies
// when it decides which names a fixture recipe may select). They are searched
// first so that a chain starts at the public wrapper; parametrized and unused
// actions follow, so nothing the profile carries goes unreported.
export function publicActions(index) {
  const definitions = topLevelDefinitions(index).filter(node => node.module === index.main && node.qualifier === 'action');
  const byKey = new Map(definitions.map(node => [node.key, node]));
  const ordered = [];
  const add = node => { if (node && !ordered.includes(node)) ordered.push(node); };
  add(definitions.find(node => node.name === 'init'));
  const step = definitions.find(node => node.name === 'step');
  if (step) {
    for (const expr of nodes(step.expr)) {
      const declaration = resolveTarget(index, expr);
      if (declaration?.kind === 'def') add(byKey.get(declaration.owner));
    }
    add(step);
  }
  return ordered;
}

// Operators that only assemble or take apart values: a record built from
// library results and inputs, a field read, a list or set literal. Everything
// else (comparison, arithmetic, branching, iteration, membership) computes,
// and computing over cache state inside a profile is rule logic.
const structuralValueOpcodes = new Set(['Rec', 'with', 'field', 'List', 'Set', 'Tup', 'Map', 'item', 'variant', 'fieldNames']);

// A composed profile assigns its own state, but every assigned value must come
// from the kernel library: the value of each assignment to a state variable
// other than the driver input is built from library transitions, record
// wiring, literals, constants and input decoding. A comparison, branch,
// arithmetic or collection operator whose operand carries cache state, or a
// non-library definition applied to cache state, is reported with the chain
// from the public wrapper. Profile definitions are followed with the taint of
// their arguments, so a helper that restates a rule over a state parameter is
// reported where it computes. Guards, choice domains, invariants and runs are
// not assignment values and are not walked: they restrict the environment or
// state independent properties.
export function lintComposition(index, { kernelModules = [] } = {}) {
  const kernel = new Set(kernelModules);
  const exposed = publicActions(index);
  const actions = [...exposed, ...topLevelDefinitions(index)
    .filter(node => node.module === index.main && node.qualifier === 'action' && !exposed.includes(node))
    .sort((left, right) => compareStrings(left.name, right.name))];
  const violations = new Map();
  const reachable = new Set();
  const assigning = new Set();
  const transitions = new Set();
  const isState = declaration => declaration?.kind === 'var';
  const isKernel = declaration => (declaration?.kind === 'def' || declaration?.kind === 'const') && kernel.has(declaration.module);
  const isProfile = declaration => declaration?.kind === 'def' && declaration.module === index.main;
  const report = (node, chain, detail) => {
    const key = `${node.key}|${detail}`;
    if (!violations.has(key)) violations.set(key, { definition: node.label, detail, chain });
  };
  // Walks one expression; returns whether its value carries cache state.
  // `tainted` maps parameter and let names of the walked body to state taint.
  const walk = (expr, { node, chain, tainted, variable }) => {
    const again = child => walk(child, { node, chain, tainted, variable });
    switch (expr.kind) {
      case 'int': case 'str': case 'bool': return false;
      case 'name': {
        const declaration = resolveTarget(index, expr);
        if (isState(declaration)) return true;
        if (declaration === undefined) return tainted.get(expr.name) === true;
        if (declaration.kind === 'const') return false;
        // A chosen input is never cache state, whatever domain it was drawn from.
        if (declaration.qualifier === 'nondet') return false;
        if (declaration.owner === node.key && !tainted.has(expr.name)) return again(declaration.expr);
        if (declaration.owner === node.key) return tainted.get(expr.name) === true;
        return isKernel(declaration) ? false : callProfile(declaration, [], { node, chain, variable });
      }
      case 'lambda': {
        const inner = new Map(tainted);
        for (const parameter of expr.params) inner.set(parameter.name, false);
        return walk(expr.expr, { node, chain, tainted: inner, variable });
      }
      case 'let': {
        const inner = new Map(tainted);
        inner.set(expr.opdef.name, expr.opdef.qualifier === 'nondet' ? false : again(expr.opdef.expr));
        // (the name case answers the same for a nondet reached without this map)
        return walk(expr.expr, { node, chain, tainted: inner, variable });
      }
      case 'app': break;
      default: return false;
    }
    const declaration = resolveTarget(index, expr);
    const stateful = expr.args.map(again);
    if (declaration) {
      if (isKernel(declaration)) {
        if (declaration.kind === 'def') transitions.add(index.labelOf(declaration.module, declaration.name));
        for (const argument of expr.args) {
          if (argument.kind === 'lambda') report(node, chain, `lambda passed to ${index.labelOf(declaration.module, declaration.name)} in the value of ${variable}`);
        }
        return true;
      }
      // A definition bound inside this body: its lambda parameters take the
      // arguments' taint like a top-level helper's do.
      if (declaration.owner === node.key) return applyBody(declaration.expr, stateful, { node, chain, variable, tainted });
      if (isProfile(declaration)) return callProfile(declaration, stateful, { node, chain, variable });
      if (stateful.some(Boolean)) report(node, chain, `${index.labelOf(declaration.module, declaration.name)} applied to cache state in the value of ${variable}`);
      return stateful.some(Boolean);
    }
    if (structuralValueOpcodes.has(expr.opcode)) return stateful.some(Boolean);
    if (stateful.some(Boolean)) report(node, chain, `${expr.opcode} over cache state in the value of ${variable}`);
    return stateful.some(Boolean);
  };
  // A body applied to arguments: its lambda parameters take the arguments'
  // taint; a parameterless body is a value walked as it stands.
  const applyBody = (body, stateful, { node, chain, variable, tainted }) => {
    const parameters = body.kind === 'lambda' ? body.params : [];
    const inner = new Map(tainted ?? []);
    parameters.forEach((parameter, position) => inner.set(parameter.name, stateful[position] === true));
    return walk(body.kind === 'lambda' ? body.expr : body, { node, chain, tainted: inner, variable });
  };
  // A profile definition applied to arguments: its body is walked with each
  // parameter tainted by its argument. A parameterless definition is a value.
  const callProfile = (declaration, stateful, { node, chain, variable }) => {
    const target = index.nodes.get(declaration.owner);
    if (!target) return stateful.some(Boolean);
    reachable.add(target.key);
    return applyBody(target.expr, stateful, { node: target, chain: [...chain, target.label], variable });
  };
  // A wrapper that applies a parametrized action decides what that action
  // assigns: each argument is walked where it is written (rule logic in an
  // argument is the wrapper's), and the taint it carries reaches the callee's
  // parameter at every call site before the callee's assignments are judged.
  const parameterTaint = new Map();
  const definitions = topLevelDefinitions(index).filter(node => node.module === index.main);
  for (const caller of definitions) {
    const own = caller.expr?.kind === 'lambda' ? new Map(caller.expr.params.map(parameter => [parameter.name, false])) : new Map();
    for (const expr of nodes(caller.expr)) {
      if (expr.kind !== 'app') continue;
      const declaration = resolveTarget(index, expr);
      if (declaration?.kind !== 'def' || declaration.qualifier !== 'action' || declaration.module !== index.main) continue;
      const callee = index.nodes.get(declaration.owner);
      if (!callee || callee.expr?.kind !== 'lambda') continue;
      const taints = parameterTaint.get(callee.key) ?? new Array(callee.expr.params.length).fill(false);
      expr.args.forEach((argument, position) => {
        // An argument that itself assigns state is a transition fragment the
        // caller's own assignments cover; a value argument is walked here.
        if (hasEffects(index, argument)) return;
        if (walk(argument, { node: caller, chain: [caller.label], tainted: own, variable: `the argument ${callee.expr.params[position]?.name} of ${callee.label}` })) taints[position] = true;
      });
      parameterTaint.set(callee.key, taints);
    }
  }
  for (const action of actions) {
    const parent = new Map([[action.key, undefined]]);
    const queue = [action];
    while (queue.length) {
      const node = queue.shift();
      if (node.kind === 'definition') reachable.add(node.key);
      const chain = [];
      for (let key = node.key; key !== undefined; key = parent.get(key)) chain.unshift(index.nodes.get(key).label);
      const assignments = assignmentsOf(index, node);
      if (assignments.length) assigning.add(node.label);
      for (const { variable, value } of assignments) {
        // A library module has no state to assign (the manifest keeps libraries
        // pure), so every assignment reached here is the profile's.
        if (variable.name === inputField) continue;
        const taints = parameterTaint.get(node.key) ?? [];
        const parameters = node.expr?.kind === 'lambda' ? node.expr.params.map((parameter, position) => [parameter.name, taints[position] === true]) : [];
        walk(value, { node, chain, tainted: new Map(parameters), variable: variableLabel(index, variable) });
      }
      for (const next of referencesOf(index, node)) {
        if (!parent.has(next.key)) { parent.set(next.key, node.key); queue.push(next); }
      }
    }
  }
  const sorted = [...violations.values()].sort((left, right) =>
    compareStrings(left.definition, right.definition) || compareStrings(left.detail, right.detail));
  return { kernelModules: [...kernel].sort(compareStrings), actions: actions.map(node => node.name).sort(compareStrings),
    publicActions: exposed.map(node => node.name), reachableDefinitions: reachable.size,
    stateAssigningDefinitions: [...assigning].sort(compareStrings), libraryTransitions: [...transitions].sort(compareStrings),
    count: sorted.length, violations: sorted };
}

// ---------------------------------------------------------------------------
// Witness isolation

// Where witness state may flow in: every definition assigning state (guards
// and assignments), the profile's init and step, every nondet domain, every
// definition assigning the observation field, and every instance override.
export function witnessRoots(index, { observationField = defaultObservationField } = {}) {
  const definitions = topLevelDefinitions(index);
  const find = name => definitions.find(node => node.module === index.main && node.name === name);
  const transitions = [], choiceDomains = [], projections = [];
  for (const node of definitions) {
    if (assignmentsOf(index, node).length) transitions.push(node.label);
    let projects = false;
    for (const expr of nodes(node.expr)) {
      if (expr.kind === 'let' && expr.opdef.qualifier === 'nondet') choiceDomains.push({ definition: node.label, choice: expr.opdef.name });
      if (expr.kind !== 'app') continue;
      if (expr.opcode === 'assign' && resolveTarget(index, expr.args[0])?.name === observationField) projects = true;
      if (expr.opcode === 'with' && expr.args[1]?.kind === 'str' && expr.args[1].value === observationField) projects = true;
      if (expr.opcode === 'Rec' && expr.args.some((arg, position) => position % 2 === 0 && arg.kind === 'str' && arg.value === observationField)) projects = true;
    }
    if (projects) projections.push(node.label);
  }
  const operatorConstants = index.instances.flatMap(instance => instance.overrides.map(override => {
    const node = index.nodes.get(override.key);
    return { instance: instance.label, constant: override.name, definitions: referencesOf(index, node).map(target => target.label) };
  }));
  // Quint orders declarations topologically, not as written; sort so the
  // report does not move when an unrelated declaration is added.
  choiceDomains.sort((left, right) => compareStrings(left.definition, right.definition) || compareStrings(left.choice, right.choice));
  return { init: find('init')?.label ?? null, step: find('step')?.label ?? null, transitions: transitions.sort(compareStrings),
    choiceDomains, projections: projections.sort(compareStrings), operatorConstants };
}

export function lintWitnessIsolation(index, { witnessPattern, observationField = defaultObservationField } = {}) {
  const pattern = witnessPattern ? new RegExp(witnessPattern) : undefined;
  const witnessVariables = [...index.declarations.values()].filter(declaration => declaration.kind === 'var' &&
    pattern && (pattern.test(declaration.name) || pattern.test(`${declaration.module}::${declaration.name}`)));
  const witnessIds = new Set(witnessVariables.map(variable => variable.id));
  const roots = witnessRoots(index, { observationField });
  const findings = new Map();
  const visited = new Set();
  const entered = new Set();

  const record = (context, variable) => {
    const finding = { kind: context.kind, ...(context.detail === undefined ? {} : { detail: context.detail }),
      root: context.root, chain: context.chain, variable: variableLabel(index, variable) };
    findings.set(`${finding.kind}|${finding.chain.join('>')}|${finding.variable}`, finding);
  };
  const enter = (node, context) => {
    const key = `${node.key}|${context.kind}`;
    if (visited.has(key)) return;
    visited.add(key);
    entered.add(node.key);
    visit(node.expr, { ...context, chain: [...context.chain, node.label], owner: node.key });
  };
  const follow = (declaration, context) => {
    if (declaration.kind === 'var') { if (witnessIds.has(declaration.id)) record(context, declaration); return; }
    if (declaration.kind === 'const') { for (const override of overrideNodes(index, declaration)) enter(override, context); return; }
    if (declaration.owner === context.owner) {
      // A let-bound definition of the definition being walked: same chain,
      // walked once per context kind. The chosen value of a nondet is an
      // input; its domain is walked as a choice-domain root at the `let`.
      if (declaration.qualifier === 'nondet') return;
      const key = `${declaration.id}|${context.kind}`;
      if (visited.has(key)) return;
      visited.add(key);
      visit(declaration.expr, context);
      return;
    }
    enter(index.nodes.get(declaration.owner), context);
  };
  const visit = (expr, context) => {
    switch (expr.kind) {
      case 'lambda': visit(expr.expr, context); return;
      case 'let':
        if (expr.opdef.qualifier === 'nondet') visit(expr.opdef.expr, { ...context, kind: 'choice domain', detail: expr.opdef.name });
        visit(expr.expr, context);
        return;
      case 'name': { const declaration = resolveTarget(index, expr); if (declaration) follow(declaration, context); return; }
      case 'app': break;
      default: return;
    }
    const declaration = resolveTarget(index, expr);
    if (declaration) {
      follow(declaration, context);
      for (const arg of expr.args) visit(arg, context);
      return;
    }
    switch (expr.opcode) {
      case 'assign': {
        const variable = resolveTarget(index, expr.args[0]);
        if (witnessIds.has(variable?.id)) return;
        const kind = variable?.name === observationField ? 'projection' : 'assignment';
        visit(expr.args[1], { ...context, kind, detail: variableLabel(index, variable) });
        return;
      }
      case 'with':
        visit(expr.args[0], context);
        visit(expr.args[1], context);
        visit(expr.args[2], expr.args[1]?.kind === 'str' && expr.args[1].value === observationField
          ? { ...context, kind: 'projection', detail: observationField } : context);
        return;
      case 'Rec':
        expr.args.forEach((arg, position) => {
          const key = expr.args[position - 1];
          visit(arg, position % 2 === 1 && key.kind === 'str' && key.value === observationField
            ? { ...context, kind: 'projection', detail: observationField } : context);
        });
        return;
      default:
        if (structuralOpcodes.has(expr.opcode) && hasEffects(index, expr)) {
          for (const arg of expr.args) visit(arg, hasEffects(index, arg) ? context : { ...context, kind: 'guard' });
          return;
        }
        for (const arg of expr.args) visit(arg, context);
    }
  };

  if (witnessIds.size) {
    const definitions = topLevelDefinitions(index);
    for (const name of ['init', 'step']) {
      const node = definitions.find(candidate => candidate.module === index.main && candidate.name === name);
      if (node) enter(node, { kind: name, root: { kind: name, definition: node.label }, chain: [] });
    }
    // Transitions and choice domains the profile does not reach from init or
    // step still count: a disabled kernel action stays a cache transition.
    for (const node of definitions) {
      if (entered.has(node.key)) continue;
      const body = [...nodes(node.expr)];
      const transition = node.qualifier === 'action' || body.some(expr => expr.kind === 'app' && expr.opcode === 'assign') ||
        body.some(expr => expr.kind === 'let' && expr.opdef.qualifier === 'nondet');
      if (transition) enter(node, { kind: 'transition', root: { kind: 'transition', definition: node.label }, chain: [] });
    }
    for (const instance of index.instances) {
      for (const override of instance.overrides) {
        const node = index.nodes.get(override.key);
        enter(node, { kind: 'operator constant', root: { kind: 'operator constant', definition: node.label }, chain: [] });
      }
    }
  }
  const sorted = [...findings.values()].sort((left, right) => compareStrings(left.kind, right.kind) ||
    compareStrings(left.chain.join('>'), right.chain.join('>')) || compareStrings(left.variable, right.variable));
  return { witnessPattern: witnessPattern ?? null, observationField, witnessVariables: witnessVariables.map(variable => variableLabel(index, variable)).sort(compareStrings),
    roots, count: sorted.length, violations: sorted };
}

// ---------------------------------------------------------------------------
// Reports and baseline

// The kernel library's module names: every module declared under formal/kernel.
// A profile may assign only values these modules compute; cache_rules is the
// judgment layer the modules consume, not one a profile assigns through.
export function kernelModulesOf(directory = root) {
  return quintSources(directory).filter(isKernelSource).flatMap(path => {
    const match = /^module\s+([A-Za-z_]\w*)\s*\{/m.exec(readFileSync(resolve(directory, path), 'utf8'));
    return match ? [match[1]] : [];
  }).sort(compareStrings);
}

export async function lintModel(model, { main, kernelModules, witnessPattern, observationField = defaultObservationField, cwd = root } = {}) {
  const parsed = await parseModel(model, { cwd });
  const index = indexModules(parsed, { main });
  const composition = lintComposition(index, { kernelModules: kernelModules ?? kernelModulesOf(cwd) });
  const witnessIsolation = lintWitnessIsolation(index, { witnessPattern, observationField });
  return { model, main: index.main, modules: index.modules, tableSize: index.tableSize, composition, witnessIsolation };
}

export function loadProfiles(directory = root) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'formal/profiles.json'), 'utf8'));
  return manifest.profiles.map(profile => ({ id: profile.id, model: profile.model }));
}

// One entry per profile: the library transitions it composes and how many of
// its assigned values still compute over cache state. A composed profile has
// no composition violations; the counts of the others are the migration work
// list. Nothing else is recorded: the lock pins the texts, and parser metrics
// would fail the check on edits that say nothing about composition.
export async function computeBaseline({ profiles, cwd = root, concurrency } = {}) {
  const selected = profiles ?? loadProfiles(cwd);
  const version = await quintVersion({ cwd });
  const kernelModules = kernelModulesOf(cwd);
  const entries = await runPool(selected.map(profile => async () => {
    const parsed = await parseModel(profile.model, { cwd });
    const index = indexModules(parsed);
    const composition = lintComposition(index, { kernelModules });
    return { id: profile.id, model: profile.model, module: index.main, libraryTransitions: composition.libraryTransitions, compositionViolations: composition.count };
  }), concurrency === undefined ? {} : { concurrency });
  return { schemaVersion: 3, quintVersion: version, kernelModules, profiles: entries };
}

// Leaf-by-leaf comparison; each difference names the JSON path.
export function diffBaseline(expected, actual, path = 'baseline') {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
    const differences = [];
    const length = Math.max(expected.length, actual.length);
    for (let position = 0; position < length; position += 1) {
      if (position >= expected.length) differences.push(`${path}[${position}]: unexpected ${JSON.stringify(actual[position])}`);
      else if (position >= actual.length) differences.push(`${path}[${position}]: missing ${JSON.stringify(expected[position])}`);
      else differences.push(...diffBaseline(expected[position], actual[position], `${path}[${position}]`));
    }
    return differences;
  }
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object') {
    const differences = [];
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)]).values()) {
      if (!Object.hasOwn(actual, key)) differences.push(`${path}.${key}: missing ${JSON.stringify(expected[key])}`);
      else if (!Object.hasOwn(expected, key)) differences.push(`${path}.${key}: unexpected ${JSON.stringify(actual[key])}`);
      else differences.push(...diffBaseline(expected[key], actual[key], `${path}.${key}`));
    }
    return differences;
  }
  return expected === actual ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

export function readBaseline(directory = root, path = baselinePath) {
  const file = resolve(directory, path);
  if (!existsSync(file)) throw new Error(`Missing ${path}; run node formal/lint-profiles.mjs baseline --write`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// The check is a ratchet over what the rule protects. Every profile keeps the
// library transitions it recorded; its violation count must match the record
// (a fall is refreshed with --write so the record never sits above reality, a
// rise fails); and a profile that composes a kernel module has no violation
// whatever the record says, so rewriting the baseline cannot admit rule logic
// into one.
export function composedViolations(baseline) {
  return baseline.profiles.filter(profile => profile.compositionViolations > 0 && profile.libraryTransitions.length > 0)
    .map(profile => `${profile.id}: ${profile.compositionViolations} composition violation(s) in a profile that composes ${profile.libraryTransitions.join(', ')}`);
}
export function ratchetDifferences(expected, actual) {
  const differences = [];
  if (expected.schemaVersion !== actual.schemaVersion) differences.push(`baseline.schemaVersion: expected ${JSON.stringify(expected.schemaVersion)}, got ${JSON.stringify(actual.schemaVersion)}`);
  if (expected.quintVersion !== actual.quintVersion) differences.push(`baseline.quintVersion: expected ${JSON.stringify(expected.quintVersion)}, got ${JSON.stringify(actual.quintVersion)}`);
  differences.push(...diffBaseline(expected.kernelModules, actual.kernelModules, 'baseline.kernelModules'));
  const recorded = new Map((expected.profiles ?? []).map(profile => [profile.id, profile]));
  for (const [position, profile] of actual.profiles.entries()) {
    const entry = recorded.get(profile.id);
    if (!entry) { differences.push(`baseline.profiles[${position}]: unexpected ${JSON.stringify(profile)}`); continue; }
    recorded.delete(profile.id);
    differences.push(...diffBaseline({ model: entry.model, module: entry.module, libraryTransitions: entry.libraryTransitions },
      { model: profile.model, module: profile.module, libraryTransitions: profile.libraryTransitions }, `baseline.profiles[${position}]`));
    if (profile.compositionViolations !== entry.compositionViolations) {
      const moved = profile.compositionViolations > entry.compositionViolations ? 'rose' : 'fell';
      differences.push(`baseline.profiles[${position}].compositionViolations: ${profile.id} ${moved} from ${entry.compositionViolations} to ${profile.compositionViolations}${moved === 'fell' ? ' (refresh the record with --write)' : ''}`);
    }
  }
  for (const entry of recorded.values()) differences.push(`baseline.profiles: missing ${JSON.stringify(entry)}`);
  return [...differences, ...composedViolations(actual)];
}

export async function checkBaseline({ cwd = root, path = baselinePath, profiles, concurrency } = {}) {
  const expected = readBaseline(cwd, path);
  const actual = await computeBaseline({ profiles, cwd, concurrency });
  return { expected, actual, differences: ratchetDifferences(expected, actual) };
}

export const formatBaseline = baseline => `${JSON.stringify(baseline, null, 2)}\n`;

// ---------------------------------------------------------------------------
// CLI

const usage = `Usage:
  node formal/lint-profiles.mjs <model.qnt> [--main=<module>] [--kernel=<module,...>] [--witness=<regex>] [--observation=<field>]
  node formal/lint-profiles.mjs baseline --check | --write

The first form prints a JSON report and exits 1 when either rule is violated;
--kernel defaults to the modules under formal/kernel. The second recomputes
${baselinePath} over every profile in formal/profiles.json and either checks
it against the committed file (--check: library transitions and violation
counts as recorded, none in a composed profile; exit 1 otherwise) or rewrites
it (--write).`;

function parseArguments(argv) {
  const options = {}, positional = [];
  for (const argument of argv) {
    if (!argument.startsWith('--')) { positional.push(argument); continue; }
    const separator = argument.indexOf('=');
    if (separator === -1) options[argument.slice(2)] = true;
    else options[argument.slice(2, separator)] = argument.slice(separator + 1);
  }
  return { options, positional };
}

async function main(argv) {
  const { options, positional } = parseArguments(argv);
  if (options.help || !positional.length) { console.log(usage); return positional.length ? 0 : 2; }
  if (positional[0] === 'baseline') {
    if (options.write) {
      const baseline = await computeBaseline();
      writeFileSync(resolve(root, baselinePath), formatBaseline(baseline));
      console.log(`Wrote ${baselinePath} for ${baseline.profiles.length} profiles with Quint ${baseline.quintVersion}.`);
      return 0;
    }
    if (options.check) {
      const { differences, actual } = await checkBaseline();
      if (differences.length) {
        console.error(`${baselinePath} drifted from the profiles (${differences.length} difference${differences.length === 1 ? '' : 's'}):`);
        for (const difference of differences) console.error(`  ${difference}`);
        console.error('Review the change, then refresh with node formal/lint-profiles.mjs baseline --write.');
        return 1;
      }
      console.log(`${baselinePath} matches ${actual.profiles.length} profiles with Quint ${actual.quintVersion}.`);
      return 0;
    }
    console.error(usage);
    return 2;
  }
  const model = positional[0];
  const relativeModel = relative(root, resolve(root, model)) || model;
  const report = await lintModel(relativeModel, {
    ...(typeof options.main === 'string' ? { main: options.main } : {}),
    ...(typeof options.kernel === 'string' ? { kernelModules: options.kernel.split(',').filter(Boolean) } : {}),
    ...(typeof options.witness === 'string' ? { witnessPattern: options.witness } : {}),
    observationField: typeof options.observation === 'string' ? options.observation : defaultObservationField,
  });
  console.log(JSON.stringify(report, null, 2));
  return report.composition.count || report.witnessIsolation.count ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => {
    console.error(error instanceof CommandFailure || error instanceof Error ? error.message : error);
    process.exitCode = typeof error?.status === 'number' && error.status > 0 ? error.status : 1;
  });
}
