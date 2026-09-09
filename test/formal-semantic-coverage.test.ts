import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../formal/check-semantic-coverage.mjs", import.meta.url));
const inventory = JSON.parse(readFileSync(new URL("../formal/semantic-cases.json", import.meta.url), "utf8")) as {
  cases: Array<{ id: string; rule: string; scenarios: string[]; models: string[]; vectors: string[]; generated: Array<{ profile: string; witness: string }>; gap?: string }>;
};
const check = (value: unknown) => execFileSync(process.execPath, [script, "--stdin"], { input: JSON.stringify(value), stdio: ["pipe", "pipe", "pipe"] }).toString();

describe("semantic coverage accounting", () => {
  it("resolves contract, scenario, model, vector and witness references", () => {
    const result = JSON.parse(check(inventory));
    expect(result.contracts).toBe(69);
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
    model.cases[0]!.models = ["formal/dialcache-core.qnt:unknownInvariant"];
    expect(() => check(model)).toThrow();
  });
});
