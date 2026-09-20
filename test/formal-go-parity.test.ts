import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Ledger = {
  status: string;
  inventory: { sourceDeclarations: number; requiredWitnesses: number; casesWithQuintRegressionReplay: number };
  sourceInventory: Array<{
    path: string;
    sha256: string;
    candidateGoFiles: string[];
    mappingReview: { goBindings: Array<{ path: string; sha256: string; symbols: string[] }> };
  }>;
  cases: Array<{ id: string; kind: string; group: string; gaps: unknown[]; evidence: { nativeGo: string[]; scope: string } }>;
  vectorExports: Array<{ model: string; artifactSha256: string }>;
  sourceDeclarationScope: {
    limitations: string;
    nativeBindingAdaptations: Array<{ id: string; rationale: string }>;
  };
  reviewedTestAndDocumentationAudit: { limitations: string; sources: Array<{ path: string; rationale: string; goFiles: string[] }> };
};
type SemanticCases = { cases: Array<{ id: string; models: string[]; quintReplays?: string[]; generatedVectors?: Array<{ artifact: string; group?: string; name: string }> }> };
type Profiles = { profiles: Array<{ id: string; model: string; smoke: string }> };
type Inputs = { semantic?: SemanticCases; profileManifest?: Profiles };

const formal = (name: string) => JSON.parse(readFileSync(new URL(`../formal/${name}`, import.meta.url), "utf8"));
const ledger = () => formal("go-parity.json") as Ledger;
const semantic = () => formal("semantic-cases.json") as SemanticCases;
const profiles = () => formal("profiles.json") as Profiles;
const checker = new URL("../formal/check-go-parity.mjs", import.meta.url).href;
// Keep the ledger in-process: these assertions test the exported accounting
// checker, so a subprocess adds no behavioral coverage.
const { checkGoParity: validate } = await import(checker) as {
  checkGoParity(input: Ledger, inputs?: Inputs): unknown;
};

describe("Go parity ledger freshness", () => {
  it("validates reviewed inventory without claiming executed parity", () => {
    const current = ledger();
    const sourceAudit = formal("source-audit.json") as { sources: unknown[] };
    const execution = formal("execution.json") as { models: Array<{ profile?: string }> };
    expect(validate(current)).toMatchObject({
      kind: "accounting-and-freshness", sourceFiles: current.sourceInventory.length,
      declarations: current.inventory.sourceDeclarations,
      reviewedTestsAndDocs: sourceAudit.sources.length, semanticCases: current.cases.length,
      profiles: execution.models.filter(model => model.profile).length, vectorModels: current.vectorExports.length,
      meaning: "Fresh reviewed mappings and inventory snapshots; execution evidence remains separately assessed.",
    });
  });

  it("rejects stale TypeScript and Go source hashes", () => {
    const typescript = ledger();
    typescript.sourceInventory[0]!.sha256 = "0".repeat(64);
    expect(() => validate(typescript)).toThrow(/source hash changed/);
    const go = ledger();
    go.sourceInventory[0]!.mappingReview.goBindings[0]!.sha256 = "0".repeat(64);
    expect(() => validate(go)).toThrow(/reviewed Go implementation changed/);
  });

  it("rejects a missing Go file or renamed referenced symbol", () => {
    const missingFile = ledger();
    missingFile.sourceInventory[0]!.candidateGoFiles[0] = "go/missing.go";
    missingFile.sourceInventory[0]!.mappingReview.goBindings[0]!.path = "go/missing.go";
    expect(() => validate(missingFile)).toThrow(/missing or invalid repository path go\/missing.go/);
    const missingSymbol = ledger();
    missingSymbol.sourceInventory[0]!.mappingReview.goBindings[0]!.symbols[0] = "MissingPolicySymbol";
    expect(() => validate(missingSymbol)).toThrow(/no longer declares MissingPolicySymbol/);
  });

  it("counts declarations scanned from src rather than stored rows", () => {
    const input = ledger();
    input.inventory.sourceDeclarations--;
    expect(() => validate(input)).toThrow(/Source inventory counts are stale/);
  });

  it("derives the profile schedule from execution.json and profiles.json", () => {
    const dropped = profiles();
    dropped.profiles.shift();
    expect(() => validate(ledger(), { profileManifest: dropped })).toThrow(/Profile inventory differs between execution.json and profiles.json/);
    const moved = profiles();
    moved.profiles[0]!.model = "formal/dialcache-missing.qnt";
    expect(() => validate(ledger(), { profileManifest: moved })).toThrow(/model differs from execution.json/);
    const smoke = profiles();
    smoke.profiles[0]!.smoke = "formal/missing-smoke.itf.json";
    expect(() => validate(ledger(), { profileManifest: smoke })).toThrow(/missing or invalid repository path formal\/missing-smoke.itf.json/);
    const cases = ledger();
    cases.cases.pop();
    expect(() => validate(cases)).toThrow(/Semantic case inventory\/order differs/);
  });

  it("derives each case's Quint evidence from semantic-cases.json and checks it against the schedule", () => {
    const unscheduled = semantic();
    unscheduled.cases[0]!.models = ["formal/dialcache-core.qnt:unknownInvariant"];
    expect(() => validate(ledger(), { semantic: unscheduled })).toThrow(/Quint check is not independently scheduled/);
    const replay = semantic();
    replay.cases.find(row => row.quintReplays?.length)!.quintReplays = ["core/doesNotExistTest"];
    expect(() => validate(ledger(), { semantic: replay })).toThrow(/Quint replay is not scheduled/);
    const vector = semantic();
    vector.cases.find(row => row.generatedVectors?.length)!.generatedVectors![0]!.name = "missing vector";
    expect(() => validate(ledger(), { semantic: vector })).toThrow(/missing generated vector reference/);
  });

  it("keeps only the reviewer's classification, group, gaps and evidence per case", () => {
    const kind = ledger();
    kind.cases[0]!.kind = "wire-protocol";
    expect(() => validate(kind)).toThrow(/case classification is stale/);
    const group = ledger();
    group.cases[0]!.group = "";
    expect(() => validate(group)).toThrow(/case group missing/);
    const native = ledger();
    native.cases[0]!.evidence.nativeGo = ["go/missing_test.go:TestMissing"];
    expect(() => validate(native)).toThrow(/missing or invalid repository path go\/missing_test.go/);
  });

  it("requires explicit native binding rationale without upgrading prose edits to evidence", () => {
    const missing = ledger();
    missing.sourceDeclarationScope.nativeBindingAdaptations[0]!.rationale = "";
    expect(() => validate(missing)).toThrow(/native binding rationale missing/);
    const prose = ledger();
    prose.sourceDeclarationScope.limitations += " Additional editorial clarification does not execute a test.";
    prose.reviewedTestAndDocumentationAudit.limitations += " Evidence is assessed separately.";
    expect(validate(prose)).toMatchObject({ kind: "accounting-and-freshness" });
  });

  it("requires a Go applicability row for every reviewed test and documentation file", () => {
    const dropped = ledger();
    dropped.reviewedTestAndDocumentationAudit.sources.pop();
    expect(() => validate(dropped)).toThrow(/applicability inventory changed/);
    const rationale = ledger();
    rationale.reviewedTestAndDocumentationAudit.sources[0]!.rationale = "";
    expect(() => validate(rationale)).toThrow(/Go applicability rationale missing/);
  });

  it("rejects omitted generated primitive vectors and stale artifact identity", () => {
    const artifact = ledger();
    artifact.vectorExports[0]!.artifactSha256 = "0".repeat(64);
    expect(() => validate(artifact)).toThrow(/artifact fingerprint is stale/);
    const inventory = ledger();
    inventory.vectorExports.pop();
    expect(() => validate(inventory)).toThrow(/Generated vector model inventory\/order differs/);
  });

  it("distinguishes referenced witnesses from the complete required gate", () => {
    const input = ledger(); input.inventory.requiredWitnesses--;
    expect(() => validate(input)).toThrow(/Required\/referenced witness inventory is stale/);
  });
});
