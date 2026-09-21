import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { scheduleExecution } from './execution.mjs';
import { readVectorArtifact } from './vector-artifacts.mjs';

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

// The declarations a production source file states: navigation for a reader
// of the mapping, counted in the ledger's inventory and never stored in it.
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

// Read-only accounting/freshness guard. Passing is not a parity or coverage proof.
//
// The ledger stores what a reviewer writes: per case its group, gaps and
// evidence paths; per production source its hash, Go bindings and mapping
// rationale; per reviewed test or documentation file its Go applicability;
// the native adaptations and the boundary treatments. Everything the other
// ledgers and the sources already state (a case's rule, contracts, cited
// checks, witnesses, replays and vectors; a source file's declarations; a
// reviewed file's hash, entries and contracts; the profile schedule) is read
// from them here and checked against execution.json and the repository, not
// stored as a copy. `inputs` lets a test substitute one of those ledgers.
export function checkGoParity(ledger = json('formal/go-parity.json'), inputs = {}) {
  const semantic = inputs.semantic ?? json('formal/semantic-cases.json');
  const execution = scheduleExecution(inputs.execution ?? json('formal/execution.json'));
  const profileManifest = inputs.profileManifest ?? json('formal/profiles.json');
  const witnessCatalog = inputs.witnessCatalog ?? json('formal/coverage-witnesses.json');
  const audit = inputs.audit ?? json('formal/source-audit.json');
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
  check(ledger.schemaVersion === 2, 'Unsupported Go parity ledger version');
  for (const [field, path] of Object.entries({ semanticCasesSha256: 'formal/semantic-cases.json', executionSha256: 'formal/execution.json', sourceAuditSha256: 'formal/source-audit.json', featureCoverageSha256: 'formal/feature-coverage.json', coverageWitnessesSha256: 'formal/coverage-witnesses.json', profilesSha256: 'formal/profiles.json' })) {
    check(ledger.inputs?.[field] === digest(path), `${path}: ledger input hash is stale; review and refresh its snapshot`);
  }
  check(equal(ledger.cases?.map(row => row.id), semantic.cases.map(row => row.id)), 'Semantic case inventory/order differs from the reviewed ledger');

  // The profile schedule: execution.json and profiles.json must name the same
  // profiles over the same models, and every smoke fixture must exist.
  const models = new Map(execution.models.filter(model => model.profile).map(model => [model.profile, model]));
  const scheduledChecks = new Set(execution.models.flatMap(model =>
    [...model.invariants, ...model.regressions].map(name => `${model.path}:${name}`)));
  const scheduledReplays = new Set(execution.models.filter(model => model.profile).flatMap(model =>
    (model.replayRegressions ?? []).map(name => `${model.profile}/${name}`)));
  check(equal(sorted(models.keys()), sorted(profileManifest.profiles.map(row => row.id))), 'Profile inventory differs between execution.json and profiles.json');
  for (const declared of profileManifest.profiles) {
    const model = models.get(declared.id);
    if (!model) continue;
    check(declared.model === model.path, `${declared.id}: profiles.json model differs from execution.json`);
    pathExists(declared.smoke, declared.id);
  }

  const behavior = semantic.cases.filter(row => row.vectors.length === 0);
  const wire = semantic.cases.filter(row => row.vectors.length > 0);
  check(ledger.inventory.behavioralCases === behavior.length && ledger.inventory.wireCases === wire.length, 'Semantic case counts are stale');
  const withWitnesses = behavior.filter(row => row.generated.length > 0);
  check(ledger.inventory.withRequiredGeneratedWitnesses === withWitnesses.length, 'Required generated witness count is stale');
  check(equal(ledger.inventory.withoutRequiredGeneratedWitnesses, behavior.filter(row => row.generated.length === 0).map(row => row.id)), 'Cases without required generated witnesses are stale');
  const referencedWitnesses = new Set(semantic.cases.flatMap(row => row.generated.map(item => `${item.profile}/${item.witness}`)));
  const requiredWitnesses = new Set(Object.entries(witnessCatalog).flatMap(([profile,names]) => names.map(name => `${profile}/${name}`)));
  check(ledger.inventory.requiredWitnesses === requiredWitnesses.size && ledger.inventory.caseReferencedWitnesses === referencedWitnesses.size, 'Required/referenced witness inventory is stale');
  for (const reference of referencedWitnesses) check(requiredWitnesses.has(reference), `Case witness is not required by the replay gate: ${reference}`);
  check(ledger.inventory.casesWithScheduledChecks === semantic.cases.filter(row => row.models.length > 0).length, 'Scheduled case check count is stale');
  check(ledger.inventory.casesWithQuintRegressionReplay === semantic.cases.filter(row => row.quintReplays?.length > 0).length, 'Quint regression replay case count is stale');
  check(ledger.inventory.casesWithQuintGeneratedVectors === semantic.cases.filter(row => row.generatedVectors?.length > 0).length, 'Quint generated vector case count is stale');
  const missingModelReplay = semantic.cases.filter(row => !row.generated.length && !row.quintReplays?.length && !row.generatedVectors?.length).map(row => row.id);
  check(equal(ledger.inventory.withoutModelDrivenReplay, missingModelReplay), 'Cases without model-driven replay are stale');
  check(ledger.inventory.quintModels === execution.models.length &&
    ledger.inventory.scheduledInvariants === execution.models.reduce((count,model) => count+model.invariants.length,0) &&
    ledger.inventory.scheduledRegressions === execution.models.reduce((count,model) => count+model.regressions.length,0), 'Quint scheduled model/check counts are stale');
  check(ledger.inventory.exportedRegressionHistories === scheduledReplays.size, 'Exported Quint regression history count is stale');
  const exportedModels = execution.models.filter(model => model.vectorExport);
  check(equal(ledger.vectorExports?.map(row => row.model), exportedModels.map(model => model.path)), 'Generated vector model inventory/order differs');
  const vectorArtifacts = new Map();
  for (const model of exportedModels) {
    const row = ledger.vectorExports?.find(item => item.model === model.path);
    check(row && equal(row.specification, model.vectorExport), `${model.path}: generated vector schedule is stale`);
    check(row?.artifactSha256 === digest(model.vectorExport.artifact), `${model.path}: generated vector artifact fingerprint is stale`);
    try { vectorArtifacts.set(model.vectorExport.artifact, readVectorArtifact(model)); }
    catch (error) { check(false, `${model.path}: ${error.message}`); }
  }
  check(ledger.inventory.quintGeneratedProtocolVectors === exportedModels.filter(model => model.vectorExport.kind === 'protocol').reduce((count,model) => count+model.vectorExport.cases,0) &&
    ledger.inventory.quintGeneratedInvalidationVectors === exportedModels.filter(model => model.vectorExport.kind === 'invalidation').reduce((count,model) => count+model.vectorExport.cases,0), 'Quint generated vector counts are stale');

  // Each case row carries the reviewer's group, gaps and evidence paths; its
  // executable evidence is the semantic case's, checked against the schedule.
  for (const row of ledger.cases) {
    const source = semantic.cases.find(item => item.id === row.id);
    if (!source) continue;
    check(row.kind === (source.vectors.length > 0 ? 'wire-protocol' : 'portable-behavior'), `${row.id}: case classification is stale`);
    check(typeof row.group === 'string' && row.group.length > 0, `${row.id}: case group missing`);
    check(Array.isArray(row.gaps), `${row.id}: case gaps must be listed`);
    const evidence = row.evidence;
    check(typeof evidence?.typescript === 'string' && typeof evidence?.go === 'string' && typeof evidence?.scope === 'string' && evidence.scope.length > 40 && Array.isArray(evidence.nativeGo), `${row.id}: evidence paths or scope missing`);
    for (const reference of evidence?.nativeGo ?? []) goFile(String(reference).split(':')[0], row.id);
    for (const required of source.generated) check(models.has(required.profile), `${row.id}: required witness profile is not scheduled: ${required.profile}`);
    for (const reference of source.models.map(entry => entry.ref)) {
      check(scheduledChecks.has(reference), `${row.id}: Quint check is not independently scheduled: ${reference}`);
      const match = /^(formal\/[^:]+\.qnt):([A-Za-z_]\w*)$/.exec(reference);
      check(Boolean(match), `${row.id}: malformed Quint obligation reference ${reference}`);
      if (match && pathExists(match[1], row.id)) check(new RegExp(`\\b(?:val|def|action|run)\\s+${match[2]}\\b`).test(read(match[1])), `${row.id}: missing named Quint obligation ${reference}`);
    }
    for (const reference of source.quintReplays ?? []) check(scheduledReplays.has(reference), `${row.id}: Quint replay is not scheduled: ${reference}`);
    for (const reference of source.generatedVectors ?? []) {
      const artifact = vectorArtifacts.get(reference.artifact);
      const vectors = artifact?.[reference.group ?? 'vectors'];
      check(Array.isArray(vectors) && (reference.name === '*' ? vectors.length > 0 : vectors.some(vector => vector.name === reference.name)), `${row.id}: missing generated vector reference`);
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
  // Each production source keeps its hash and reviewed Go bindings; its
  // declarations are scanned from src/ and only counted.
  check(equal(ledger.sourceInventory.map(row => row.path), sourcePaths()), 'Production TypeScript source file inventory changed');
  let declarations = 0;
  for (const source of ledger.sourceInventory) {
    if (!pathExists(source.path, 'Source inventory')) continue;
    check(source.sha256 === digest(source.path), `${source.path}: source hash changed; mapping review is stale`);
    declarations += sourceDeclarationSnapshot(source.path).length;
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
  // Each test or documentation file the source audit reviews has a Go
  // applicability row; the file's hash, entries and contracts are the audit's.
  const reviewed = ledger.reviewedTestAndDocumentationAudit;
  check(reviewed?.path === 'formal/source-audit.json', 'Test/documentation applicability audit must review formal/source-audit.json');
  check(reviewed?.status === 'reviewed-applicability-not-execution', 'Test/documentation review must distinguish applicability from execution');
  check(equal(reviewed?.sources?.map(source => source.path), audit.sources.map(source => source.path)), 'Test/documentation applicability inventory changed');
  for (const source of reviewed?.sources ?? []) {
    const original = audit.sources.find(item => item.path === source.path);
    if (!original) continue;
    if (pathExists(source.path, 'Test/documentation audit')) check(original.sha256 === digest(source.path), `${source.path}: reviewed test/documentation contents changed`);
    check(typeof source.rationale === 'string' && source.rationale.length > 60, `${source.path}: Go applicability rationale missing`);
    check(source.goFiles?.length > 0, `${source.path}: Go applicability references missing`);
    for (const path of source.goFiles ?? []) goFile(path, source.path);
    for (const id of source.nativeAdaptations ?? []) check(adaptations.has(id), `${source.path}: unknown adaptation ${id}`);
  }
  // File relocation must include optional boundary evidence owned by exporters.
  for (const boundary of ledger.boundaries) for (const reference of boundary.nativeTests ?? []) goFile(reference.split(':')[0], boundary.id);
  if (failures.length) throw new Error(failures.join('\n'));
  return { kind: 'accounting-and-freshness', sourceFiles: ledger.sourceInventory.length, declarations, reviewedTestsAndDocs: audit.sources.length, semanticCases: ledger.cases.length, profiles: models.size, vectorModels: exportedModels.length, status: ledger.status, meaning: 'Fresh reviewed mappings and inventory snapshots; execution evidence remains separately assessed.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(checkGoParity());
