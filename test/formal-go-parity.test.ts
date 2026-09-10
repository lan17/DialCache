import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Ledger = {
  status: string;
  inventory: { sourceDeclarations: number };
  sourceInventory: Array<{
    path: string;
    sha256: string;
    declarations: unknown[];
    candidateGoFiles: string[];
    mappingReview: { goBindings: Array<{ path: string; sha256: string; symbols: string[] }> };
  }>;
  profiles: Array<{ id: string; version: number }>;
  cases: Array<{ id: string; status: string }>;
  sourceDeclarationScope: {
    limitations: string;
    nativeBindingAdaptations: Array<{ id: string; rationale: string }>;
  };
  reviewedTestAndDocumentationAudit: { limitations: string };
};

const ledger = () => JSON.parse(readFileSync(new URL("../formal/go-parity.json", import.meta.url), "utf8")) as Ledger;
const checker = new URL("../formal/check-go-parity.mjs", import.meta.url).href;
const validate = (input: Ledger): unknown => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
  import { readFileSync } from 'node:fs';
  import { checkGoParity } from ${JSON.stringify(checker)};
  console.log(JSON.stringify(checkGoParity(JSON.parse(readFileSync(0, 'utf8')))));
`], { input: JSON.stringify(input), stdio: ["pipe", "pipe", "pipe"] }).toString());

describe("Go parity ledger freshness", () => {
  it("validates reviewed inventory without claiming executed parity", () => {
    expect(validate(ledger())).toMatchObject({
      kind: "accounting-and-freshness", sourceFiles: 27, declarations: 772,
      reviewedTestsAndDocs: 44, semanticCases: 261, profiles: 9,
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

  it("rejects dropped declarations even when the count is adjusted", () => {
    const input = ledger();
    input.sourceInventory[0]!.declarations.pop();
    input.inventory.sourceDeclarations--;
    expect(() => validate(input)).toThrow(/declaration inventory\/navigation changed/);
  });

  it("rejects stale profile and semantic case inventories", () => {
    const profile = ledger();
    profile.profiles[0]!.version++;
    expect(() => validate(profile)).toThrow(/profile version\/model\/smoke differs/);
    const cases = ledger();
    cases.cases.pop();
    expect(() => validate(cases)).toThrow(/Semantic case inventory\/order differs/);
  });

  it("requires explicit native binding rationale without upgrading prose edits to evidence", () => {
    const missing = ledger();
    missing.sourceDeclarationScope.nativeBindingAdaptations[0]!.rationale = "";
    expect(() => validate(missing)).toThrow(/native binding rationale missing/);
    const prose = ledger();
    const statuses = prose.cases.map(row => row.status);
    prose.sourceDeclarationScope.limitations += " Additional editorial clarification does not execute a test.";
    prose.reviewedTestAndDocumentationAudit.limitations += " Evidence is assessed separately.";
    expect(validate(prose)).toMatchObject({ kind: "accounting-and-freshness" });
    expect(prose.cases.map(row => row.status)).toEqual(statuses);
  });
});
