import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Citation = { ref: string; scope: string };
const moduleUrl = new URL("../formal/check-semantic-coverage.mjs", import.meta.url).href;
const { checkSemanticCoverage, checkProfiles } = await import(moduleUrl) as {
  checkSemanticCoverage(value: unknown): unknown;
  checkProfiles(value: unknown): unknown;
};
const inventory = JSON.parse(readFileSync(new URL("../formal/semantic-cases.json", import.meta.url), "utf8")) as {
  cases: Array<{ id: string; rule: string; scenarios: string[]; models: Citation[]; definitions?: Citation[]; vectors: string[]; generated: Array<{ profile: string; witness: string }>; quintReplays?: string[]; generatedVectors?: Array<{ artifact: string; group?: string; name: string }>; gap?: string }>;
};
const check = (value: unknown) => JSON.stringify(checkSemanticCoverage(value));

// Every case re-checks the whole inventory against the Quint sources; the
// hosted runner is about ten times slower than a laptop (5.2 s versus 0.5 s
// for the definition-citation case), so the suite carries an explicit budget.
describe("semantic coverage accounting", { timeout: 30_000 }, () => {
  it("rejects incompatible profile registries and schema drift", () => {
    const registry = JSON.parse(readFileSync(new URL("../formal/profiles.json", import.meta.url), "utf8"));
    expect(() => checkProfiles(registry)).not.toThrow();
    expect(() => checkProfiles({ ...registry, protocolSchemaVersion: 99 })).toThrow();
    expect(() => checkProfiles({ ...registry, profiles: registry.profiles.slice(1) })).toThrow();
    expect(() => checkProfiles({ ...registry, specificationVersion: "unrecognized" })).toThrow();
  });
  it("resolves contract, scenario, model, vector and witness references", () => {
    const result = JSON.parse(check(inventory));
    expect(result.contracts).toBe([...readFileSync(new URL("../formal/CONTRACTS.md", import.meta.url), "utf8").matchAll(/^\| ([CW]\d{2}) \|/gm)].length);
    expect(result.cases.total).toBe(inventory.cases.length);
  });
  it("rejects duplicate cases and missing executable evidence without an explicit gap", () => {
    const duplicate = structuredClone(inventory);
    duplicate.cases.push(duplicate.cases[0]!);
    expect(() => check(duplicate)).toThrow();
    const missing = structuredClone(inventory);
    Object.assign(missing.cases[0]!, { scenarios: [], generated: [], vectors: [], models: [] });
    expect(() => check(missing)).toThrow();
  });
  it("rejects a trace action masquerading as a required behavioral witness", () => {
    const broken = structuredClone(inventory);
    broken.cases[0]!.generated = [{ profile: "shadow", witness: "action:beginCall" }];
    expect(() => check(broken)).toThrow();
  });
  it("rejects dangling scenario and model references", () => {
    const scenario = structuredClone(inventory);
    scenario.cases[0]!.scenarios = ["nonexistent case"];
    expect(() => check(scenario)).toThrow();
    const model = structuredClone(inventory);
    model.cases[0]!.models = [{ ref: "formal/dialcache-core.qnt:unknownInvariant", scope: "A check that is not scheduled." }];
    expect(() => check(model)).toThrow();
  });
  it("rejects a valid case inventory that silently drops a positive scenario", () => {
    const broken = structuredClone(inventory);
    for (const c of broken.cases) c.scenarios = c.scenarios.filter(name => name !== "disabled calls bypass policy and caches");
    expect(() => check(broken)).toThrow(/Portable scenarios missing from case inventory/);
  });
  it("rejects a protocol group with valid but incomplete vector references", () => {
    const broken = structuredClone(inventory);
    const vectors = JSON.parse(readFileSync(new URL("../formal/protocol-vectors.json", import.meta.url), "utf8"));
    for (const c of broken.cases) c.vectors = c.vectors.map(name => name === "protocol/keyVectors/*"
      ? `protocol/keyVectors/${vectors.keyVectors[0].name}` : name);
    expect(() => check(broken)).toThrow(/Protocol vector missing from case inventory/);
  });
  it("requires every portable case to keep a Quint check and implementation replay", () => {
    const noCheck = structuredClone(inventory);
    Object.assign(noCheck.cases[0]!, { models: [], quintReplays: [], generatedVectors: undefined });
    expect(() => check(noCheck)).toThrow(/requires a scheduled Quint check/);
    const fixedOnly = structuredClone(inventory);
    Object.assign(fixedOnly.cases[0]!, { generated: [], quintReplays: [], generatedVectors: undefined });
    expect(() => check(fixedOnly)).toThrow(/requires Quint-driven implementation replay/);
  });
  it("requires a reviewed scope on every Quint citation", () => {
    const blank = structuredClone(inventory);
    blank.cases[0]!.models[0]!.scope = " ";
    expect(() => check(blank)).toThrow(/Invalid\/duplicate Quint citation or missing scope/);
    const duplicate = structuredClone(inventory);
    duplicate.cases[0]!.models.push({ ...duplicate.cases[0]!.models[0]! });
    expect(() => check(duplicate)).toThrow(/Invalid\/duplicate Quint citation or missing scope/);
    const helper = structuredClone(inventory);
    helper.cases[0]!.models[0]!.ref = "formal/dialcache-core.qnt:localWriteEligible";
    expect(() => check(helper)).toThrow(/model property is not scheduled for execution/);
  });
  it("rejects a definition citation that names a scheduled property or no declaration", () => {
    const defined = inventory.cases.find(c => c.definitions?.length)!;
    const property = structuredClone(inventory);
    property.cases.find(c => c.id === defined.id)!.definitions![0]!.ref = defined.models[0]!.ref;
    expect(() => check(property)).toThrow(/not a transition\/helper\/predicate/);
    const missing = structuredClone(inventory);
    missing.cases.find(c => c.id === defined.id)!.definitions![0]!.ref = "formal/dialcache-core.qnt:missingAction";
    expect(() => check(missing)).toThrow(/not a transition\/helper\/predicate/);
    const unknownModel = structuredClone(inventory);
    unknownModel.cases.find(c => c.id === defined.id)!.definitions![0]!.ref = "formal/missing.qnt:localWriteEligible";
    expect(() => check(unknownModel)).toThrow(/Unknown Quint definition model/);
    const unscoped = structuredClone(inventory);
    unscoped.cases.find(c => c.id === defined.id)!.definitions![0]!.scope = "";
    expect(() => check(unscoped)).toThrow(/Invalid\/duplicate Quint citation or missing scope/);
    const result = JSON.parse(check(inventory)) as { citations: { scopedChecks: number; definitions: number; casesWithDefinitions: number } };
    expect(result.citations.scopedChecks).toBe(inventory.cases.reduce((n, c) => n + c.models.length, 0));
    expect(result.citations.definitions).toBe(inventory.cases.reduce((n, c) => n + (c.definitions?.length ?? 0), 0));
    expect(result.citations.casesWithDefinitions).toBe(inventory.cases.filter(c => c.definitions?.length).length);
  });
  it("rejects replay names that are not exported cited Quint tests", () => {
    const broken = structuredClone(inventory);
    broken.cases[0]!.quintReplays = ["policy/doesNotExistTest"];
    expect(() => check(broken)).toThrow(/cited scheduled exported regression/);
  });
  it("rejects missing, wrong-model and duplicate generated vector references", () => {
    for (const change of [
      (c: (typeof inventory.cases)[number]) => { c.generatedVectors![0]!.name = "missing vector"; },
      (c: (typeof inventory.cases)[number]) => { c.models = [{ ref: "formal/dialcache-core.qnt:closedScopeHasNoRequestValue", scope: "A check of another model." }]; },
      (c: (typeof inventory.cases)[number]) => { c.generatedVectors!.push(c.generatedVectors![0]!); },
    ]) {
      const broken = structuredClone(inventory);
      change(broken.cases.find(c => c.id === "W01.key-identity")!);
      expect(() => check(broken)).toThrow(/generated vector needs a cited model and exported case/);
    }
  });

});
