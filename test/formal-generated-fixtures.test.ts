import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { validateRecipes, verifyFixtures, project, stateDelta, constrainAction } = await import(
  new URL("../formal/generated-fixtures.mjs", import.meta.url).href,
) as {
  validateRecipes(book: unknown): unknown;
  verifyFixtures(book?: unknown, execution?: unknown): { artifacts: number; histories: number };
  project(value: unknown, mask: unknown): unknown;
  stateDelta(before: unknown, after: unknown): unknown;
  constrainAction(source: string, declaration: unknown, sourceMap: unknown, choice: number): string;
};
const { encodeJson } = await import(new URL("../formal/compact-json.mjs", import.meta.url).href) as {
  encodeJson(value: unknown, record?: (path: Array<string | number>, node: unknown) => boolean): string;
};
const { importClosure, readExecution } = await import(new URL("../formal/execution.mjs", import.meta.url).href) as {
  importClosure(path: string): string[];
  readExecution(): { settings: { backend: string; seed: string } };
};
type Book = { artifacts: Array<{ path: string; format: string; model?: string; recipes: Array<{ model?: string }> }> };
type Lock = { settings: { backend: string; seed: string }; inputs: Record<string, string>; artifacts: Record<string, string> };
const book = () => JSON.parse(readFileSync("formal/fixture-recipes.json", "utf8"));
const lock = (): Lock => JSON.parse(readFileSync("formal/generated-fixtures.lock.json", "utf8")) as Lock;

describe("reproducible Quint fixtures", () => {
  it("binds every committed fixture to its recipes, models and exporter without requiring Quint", () => {
    expect(verifyFixtures()).toEqual({ artifacts: 31, histories: 157 });
  });
  it("pins only what the generated fixtures read: recipes, generator, encoder, the recipe models' import closures and the export settings", () => {
    const recipes = book() as Book;
    const models = [...new Set(recipes.artifacts.flatMap(artifact => artifact.recipes.map(recipe => recipe.model ?? artifact.model!)))];
    const expected = [...new Set(["formal/fixture-recipes.json", "formal/generated-fixtures.mjs", "formal/compact-json.mjs", ...models.flatMap(model => importClosure(model))])].sort();
    expect(Object.keys(lock().inputs)).toEqual(expected);
    for (const path of ["formal/execution.json", "formal/profiles.json", "formal/execution.mjs"]) expect(lock().inputs, path).not.toHaveProperty(path);
    const { settings } = readExecution();
    expect(lock().settings).toEqual({ backend: settings.backend, seed: settings.seed });
    // A seed or backend change would change every exported history: the lock must notice without a Quint run.
    expect(() => verifyFixtures(undefined, { settings: { ...settings, seed: "0x1" } })).toThrow(/inputs changed/);
    expect(() => verifyFixtures(undefined, { settings: { ...settings, backend: "typescript" } })).toThrow(/inputs changed/);
  });
  it("writes the envelope indented and every record on one line, and matches JSON.stringify without records", () => {
    const value = { a: 1, b: [1, { c: [] }, {}], d: { e: "x", f: null }, g: [] };
    expect(encodeJson(value)).toBe(JSON.stringify(value, null, 2) + "\n");
    expect(encodeJson({ states: [{ s: { o: [1] } }, { s: { o: [2] } }], meta: { x: 1 } }, path => path.at(-2) === "states"))
      .toBe('{\n  "states": [\n    {"s":{"o":[1]}},\n    {"s":{"o":[2]}}\n  ],\n  "meta": {\n    "x": 1\n  }\n}\n');
    // Every committed smoke history costs one line per state plus its envelope.
    for (const artifact of (book() as Book).artifacts.filter(entry => entry.format === "smoke")) {
      const text = readFileSync(artifact.path, "utf8");
      const states = (JSON.parse(text) as { states: unknown[] }).states.length;
      expect(text.split("\n").length - 1, artifact.path).toBeLessThanOrEqual(states + 16);
    }
  });
  it("rejects missing fixtures, duplicate identities and expected-state recipes", () => {
    const missing = book(); missing.artifacts.pop();
    expect(() => validateRecipes(missing)).toThrow(/inventory/);
    const duplicate = book(); duplicate.artifacts.push(duplicate.artifacts[0]);
    expect(() => validateRecipes(duplicate)).toThrow(/duplicate/);
    const prediction = book(); prediction.artifacts[0].recipes[0].expected = { returned: 1 };
    expect(() => validateRecipes(prediction)).toThrow(/expected state/);
    const privateState = book(); privateState.projections[privateState.artifacts[0].recipes[0].projection] = { value: 42 };
    expect(() => validateRecipes(privateState)).toThrow(/field names only/);
  });
  it("projects only existing output and encodes changes without inventing observations", () => {
    expect(project({ returned: 1, privatePhase: 2 }, { returned: true })).toEqual({ returned: 1 });
    expect(() => project({}, { returned: true })).toThrow(/missing/);
    expect(stateDelta({ o: { calls: [1], reads: 1 } }, { o: { calls: [1, 2], reads: 1 } })).toEqual({ o: { calls: [1, 2] } });
    expect(() => stateDelta({ o: 1 }, {})).toThrow(/remove/);
  });
  it("narrows the original choice domain and preserves guards and assignments", () => {
    const source = "nondet choice = Set(1, 2).oneOf(); all { s < 3, s' = choice }";
    const domainStart = source.indexOf("Set"), domainEnd = source.indexOf(".oneOf");
    const choice = { name: "choice", qualifier: "nondet", expr: { opcode: "oneOf", args: [{ id: 2 }] } };
    const declaration = { kind: "def", qualifier: "action", expr: { id: 1, kind: "let", opdef: choice } };
    const sourceMap = { map: { "1": [0, { index: 0 }, { index: source.length - 1 }], "2": [0, { index: domainStart }, { index: domainEnd - 1 }] } };
    expect(constrainAction(source, declaration, sourceMap, 2)).toContain("Set(1, 2)).intersect(Set(2)).oneOf(); all { s < 3, s' = choice }");
    expect(() => constrainAction(source, declaration, sourceMap, -1)).toThrow(/Missing/);
    expect(() => constrainAction(source, { ...declaration, expr: { ...declaration.expr, second: choice } }, sourceMap, 1)).toThrow(/ambiguous/);
    expect(() => constrainAction(source, { ...declaration, qualifier: "run" }, sourceMap, 1)).toThrow(/public action/);
  });
});
