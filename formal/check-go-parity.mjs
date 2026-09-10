import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(root + path, 'utf8');
const json = path => JSON.parse(read(path));
const digest = path => createHash('sha256').update(readFileSync(root + path)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = values => [...values].sort();

function sourcePaths(directory = 'src') {
  return readdirSync(root + directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sourcePaths(`${directory}/${entry.name}`) :
      entry.name.endsWith('.ts') ? [`${directory}/${entry.name}`] : []).sort();
}

// The declaration list is navigation, not an assertion inventory. Enumerate the
// stated scope so removing a ledger row cannot silently drop an API member.
export function sourceDeclarationSnapshot(path) {
  const ast = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
  const declarations = [];
  const kinds = new Set(['ClassDeclaration', 'InterfaceDeclaration', 'TypeAliasDeclaration', 'FunctionDeclaration', 'EnumDeclaration', 'PropertyDeclaration', 'PropertySignature', 'MethodDeclaration', 'MethodSignature', 'Constructor']);
  function visit(node) {
    const kind = ts.SyntaxKind[node.kind];
    const topLevelVariable = ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent);
    const name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText(ast);
    if ((kinds.has(kind) || topLevelVariable) && name) {
      let owner = node.parent;
      while (owner && !ts.isClassDeclaration(owner) && !ts.isInterfaceDeclaration(owner)) owner = owner.parent;
      const qualified = owner?.name ? `${owner.name.getText(ast)}.${name}` : name;
      const line = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;
      declarations.push({ name: qualified, kind, line });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return declarations;
}

function goSymbols(path) {
  return new Set([...read(path).matchAll(/^(?:func\s+(?:\([^\n]*?\)\s+)?|(?:type|const|var)\s+)([A-Za-z_]\w*)/gm)].map(match => match[1]));
}

/** Read-only accounting/freshness guard. Passing is not a parity or coverage proof. */
export function checkGoParity(ledger = json('formal/go-parity.json')) {
  const semantic = json('formal/semantic-cases.json');
  const applicability = json('formal/quint-case-audit.json');
  const execution = json('formal/execution.json');
  const profileManifest = json('formal/profiles.json');
  const audit = json('formal/source-audit.json');
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const pathExists = (path, context) => {
    const valid = typeof path === 'string' && !path.includes('..') && existsSync(root + path);
    check(valid, `${context}: missing or invalid repository path ${path}`);
    return valid;
  };
  const goFile = (path, context) => {
    check(typeof path === 'string' && path.startsWith('go/') && path.endsWith('.go'), `${context}: expected a production/test Go source path, got ${path}`);
    return pathExists(path, context);
  };
  check(ledger.schemaVersion === 1, 'Unsupported Go parity ledger version');
  for (const [field, path] of Object.entries({ semanticCasesSha256: 'formal/semantic-cases.json', executionSha256: 'formal/execution.json', sourceAuditSha256: 'formal/source-audit.json', quintCaseAuditSha256: 'formal/quint-case-audit.json', featureCoverageSha256: 'formal/feature-coverage.json' })) {
    check(ledger.inputs?.[field] === digest(path), `${path}: ledger input hash is stale; review and refresh its snapshot`);
  }
  check(equal(ledger.cases?.map(row => row.id), semantic.cases.map(row => row.id)), 'Semantic case inventory/order differs from the reviewed ledger');
  const models = new Map(execution.models.filter(model => model.profile).map(model => [model.profile, model]));
  check(equal(sorted(ledger.profiles.map(row => row.id)), sorted(models.keys())), 'Generated profile inventory differs from execution.json');
  check(equal(sorted(ledger.profiles.map(row => row.id)), sorted(profileManifest.profiles.map(row => row.id))), 'Profile inventory differs from profiles.json');
  for (const profile of ledger.profiles) {
    const model = models.get(profile.id);
    if (!model) continue;
    check(profile.model === model.path && profile.plannedTraces === model.generate.traces, `${profile.id}: model or planned trace count is stale`);
    const declared = profileManifest.profiles.find(row => row.id === profile.id);
    check(declared && profile.version === declared.version && profile.model === declared.model && profile.smoke === declared.smoke, `${profile.id}: profile version/model/smoke differs from profiles.json`);
    pathExists(profile.smoke, profile.id);
  }
  const behavior = semantic.cases.filter(row => row.vectors.length === 0);
  const wire = semantic.cases.filter(row => row.vectors.length > 0);
  check(ledger.inventory.behavioralCases === behavior.length && ledger.inventory.wireCases === wire.length, 'Semantic case counts are stale');
  const withWitnesses = behavior.filter(row => row.generated.length > 0);
  check(ledger.inventory.withRequiredGeneratedWitnesses === withWitnesses.length, 'Required generated witness count is stale');
  check(equal(ledger.inventory.withoutRequiredGeneratedWitnesses, behavior.filter(row => row.generated.length === 0).map(row => row.id)), 'Cases without required generated witnesses are stale');
  for (const row of ledger.cases) {
    const source = semantic.cases.find(item => item.id === row.id);
    if (!source) continue;
    check(row.kind === (source.vectors.length > 0 ? 'wire-protocol' : 'portable-behavior'), `${row.id}: case classification is stale`);
    check(equal(row.contracts, source.contracts) && row.rule === source.rule, `${row.id}: contract or rule snapshot is stale`);
    check(equal(row.quintProperties, source.models) && equal(row.fixedRegressions, source.scenarios) && equal(row.vectorEvidence, source.vectors), `${row.id}: executable evidence references are stale`);
    check(row.scopeAudit === 'formal/quint-case-audit.json' && equal(row.quintDefinitions, applicability.definitions.filter(item => item.case === row.id).map(item => item.reference)), `${row.id}: scoped Quint definitions are stale`);
    check(equal(row.requiredGenerated.map(({ profile, witness }) => ({ profile, witness })), source.generated), `${row.id}: required witness snapshot is stale`);
    for (const required of row.requiredGenerated) check(required.model === models.get(required.profile)?.path, `${row.id}: required witness model is stale`);
    for (const reference of row.quintProperties ?? []) {
      const match = /^(formal\/[^:]+\.qnt):([A-Za-z_]\w*)$/.exec(reference);
      check(Boolean(match), `${row.id}: malformed Quint obligation reference ${reference}`);
      if (match && pathExists(match[1], row.id)) check(new RegExp(`\\b(?:val|def|action|run)\\s+${match[2]}\\b`).test(read(match[1])), `${row.id}: missing named Quint obligation ${reference}`);
    }
  }

  const scope = ledger.sourceDeclarationScope;
  check(scope?.status === 'reviewed-source-file-mappings', 'Source declaration mapping review is missing');
  check(typeof scope?.limitations === 'string' && scope.limitations.length > 80, 'Declaration review must state its evidentiary limits');
  const adaptations = new Map((scope?.nativeBindingAdaptations ?? []).map(row => [row.id, row]));
  for (const id of ['B01', 'B02', 'B03', 'X01', 'X02']) check(adaptations.has(id), `${id}: explicit native binding adaptation missing`);
  for (const adaptation of adaptations.values()) {
    check(typeof adaptation.rationale === 'string' && adaptation.rationale.length > 80, `${adaptation.id}: native binding rationale missing`);
    check(adaptation.references?.length > 0, `${adaptation.id}: native binding references missing`);
    for (const path of adaptation.references ?? []) pathExists(path, adaptation.id);
  }
  check(equal(ledger.sourceInventory.map(row => row.path), sourcePaths()), 'Production TypeScript source file inventory changed');
  let declarations = 0;
  for (const source of ledger.sourceInventory) {
    declarations += source.declarations.length;
    if (!pathExists(source.path, 'Source inventory')) continue;
    check(source.sha256 === digest(source.path), `${source.path}: source hash changed; mapping review is stale`);
    check(equal(source.declarations.map(({ name, kind, line }) => ({ name, kind, line })), sourceDeclarationSnapshot(source.path)), `${source.path}: declaration inventory/navigation changed`);
    for (const declaration of source.declarations) {
      check(declaration.status === 'inherits-source-file-mapping', `${source.path}:${declaration.line}: declaration must inherit a reviewed file mapping`);
    }
    const review = source.mappingReview;
    check(review?.status === 'reviewed-mapping-not-execution', `${source.path}: source mapping review missing`);
    check(typeof review?.rationale === 'string' && review.rationale.length > 80, `${source.path}: precise mapping rationale missing`);
    check(review?.goBindings?.length > 0, `${source.path}: Go binding mapping missing`);
    check(equal(source.candidateGoFiles, review?.goBindings?.map(binding => binding.path)), `${source.path}: Go file list differs from reviewed bindings`);
    for (const binding of review?.goBindings ?? []) {
      if (!goFile(binding.path, source.path)) continue;
      check(binding.sha256 === digest(binding.path), `${source.path}: reviewed Go implementation changed in ${binding.path}`);
      const names = goSymbols(binding.path);
      check(binding.symbols?.length > 0, `${source.path}: Go symbol references missing`);
      for (const symbol of binding.symbols ?? []) check(names.has(symbol), `${source.path}: ${binding.path} no longer declares ${symbol}`);
    }
    for (const id of review?.nativeAdaptations ?? []) check(adaptations.has(id), `${source.path}: unknown native adaptation ${id}`);
  }
  check(ledger.inventory.sourceFiles === ledger.sourceInventory.length && ledger.inventory.sourceDeclarations === declarations, 'Source inventory counts are stale');
  const reviewed = ledger.reviewedTestAndDocumentationAudit;
  check(reviewed?.path === 'formal/source-audit.json' && reviewed.sha256 === digest('formal/source-audit.json'), 'Test/documentation applicability audit hash is stale');
  check(reviewed?.status === 'reviewed-applicability-not-execution', 'Test/documentation review must distinguish applicability from execution');
  check(reviewed.sourceFiles === audit.sources.length && equal(reviewed.sources?.map(source => source.path), audit.sources.map(source => source.path)), 'Test/documentation applicability inventory changed');
  for (const source of reviewed.sources ?? []) {
    const original = audit.sources.find(item => item.path === source.path);
    if (!original) continue;
    check(source.sha256 === original.sha256 && source.entries === original.entries.length, `${source.path}: applicability snapshot changed`);
    if (pathExists(source.path, 'Test/documentation audit')) check(source.sha256 === digest(source.path), `${source.path}: reviewed test/documentation contents changed`);
    check(equal(source.contracts, sorted(new Set(original.entries.flatMap(entry => entry.contracts)))), `${source.path}: applicability contract inventory changed`);
    check(typeof source.rationale === 'string' && source.rationale.length > 60, `${source.path}: Go applicability rationale missing`);
    check(source.goFiles?.length > 0, `${source.path}: Go applicability references missing`);
    for (const path of source.goFiles ?? []) goFile(path, source.path);
    for (const id of source.nativeAdaptations ?? []) check(adaptations.has(id), `${source.path}: unknown adaptation ${id}`);
  }
  // File relocation must include optional boundary evidence owned by exporters.
  for (const boundary of ledger.boundaries) for (const reference of boundary.nativeTests ?? []) goFile(reference.split(':')[0], boundary.id);
  if (failures.length) throw new Error(failures.join('\n'));
  return { kind: 'accounting-and-freshness', sourceFiles: ledger.sourceInventory.length, declarations, reviewedTestsAndDocs: reviewed.sourceFiles, semanticCases: ledger.cases.length, profiles: ledger.profiles.length, status: ledger.status, meaning: 'Fresh reviewed mappings and inventory snapshots; execution evidence remains separately assessed.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(checkGoParity());
