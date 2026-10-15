import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { checkStyle, measure, renderReport, headerLines, definitions, caps } = await import(
  new URL("../../formal/tools/check-style.mjs", import.meta.url).href,
) as {
  checkStyle(options?: { directory?: string; allowlist?: { lineLength?: string[]; headerLength?: string[] } }): { files: number; lineLengthChecked: number; allowlisted: number };
  measure(directory?: string): {
    files: number; linesOver: { total: number; fixtures: number }; headers: { longest: number; overCap: number };
    commentSentences: { count: number; over40: number; longest: number }; guideSentences: { count: number; over40: number; longest: number };
    definitions: { count: number; sixOrMoreParameters: { models: number; kernel: number; fixtures: number }; twoBooleanParameters: string[] }; exclusionReasons: number;
  };
  renderReport(measurements: unknown): string;
  headerLines(lines: string[]): number;
  definitions(text: string): Array<{ name: string; params: string[] }>;
  caps: { lineLength: number; headerLength: number };
};
const { validationPlan } = await import(new URL("../../formal/tools/validation.mjs", import.meta.url).href) as {
  validationPlan(target: string, options: { directory: string }): Array<{ args?: string[] }>;
};
const root = fileURLToPath(new URL("../../", import.meta.url));

describe("Quint style caps", () => {
  let directory: string;
  const put = (path: string, text: string) => writeFileSync(join(directory, path), text);
  const longLine = `  pure val wide = ${"1 + ".repeat(40)}1`;
  const header = (lines: number) => ["module m {", ...Array.from({ length: lines }, (_, i) => `  // Header line ${i + 1}.`), "  pure val x = 1", "}", ""].join("\n");

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dialcache-style-"));
    for (const path of ["formal/models/kernel", "formal/models/fixtures/kernel", "formal/guides", "formal/catalogs"]) mkdirSync(join(directory, path), { recursive: true });
    put("formal/models/clean.qnt", header(3));
    put("formal/models/kernel/tall.qnt", header(26));
    put("formal/models/fixtures/kernel/wide.qnt", `module w {\n${longLine}\n}\n`);
    put("formal/models/fixtures/kernel/leading.qnt", [...Array.from({ length: 27 }, (_, i) => `// Leading line ${i + 1}.`), "module l {", "  pure val x = 1", "}", ""].join("\n"));
    put("formal/models/defs.qnt", ["module d {", "  // ---- Banner line ----", "  // A sentence.", ...Array.from({ length: 5 }, () => `  // ${"word ".repeat(9).trim()}`), "  // ends.", "  pure def f(a: int, b: bool, c: int, d: bool) = a",
      "  action g(x: bool, y: bool): bool = true", "  pure def h(a: int, b: int, c: int, d: int, e: int, f: int) = a", "  pure def k(step: (int, int) => int, v: bool) = v", "}", ""].join("\n"));
    put("formal/guides/GUIDE.md", "# Guide\n\nShort sentence. " + "word ".repeat(45) + "ends here.\n");
    put("formal/README.md", "# Formal\n\nOne sentence.\n");
    put("formal/catalogs/execution.json", JSON.stringify({ challenges: [{ reproducer: { exclusions: { a: "free text", b: { reason: "slug" } } } }] }));
    put("formal/catalogs/style-allowlist.json", JSON.stringify({ lineLength: ["formal/models/fixtures/kernel/wide.qnt"], headerLength: ["formal/models/kernel/tall.qnt", "formal/models/fixtures/kernel/leading.qnt"] }));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("passes when every offender is allowlisted and counts what it checked", () => {
    expect(checkStyle({ directory })).toEqual({ files: 5, lineLengthChecked: 4, allowlisted: 3 });
  });

  it("fails a long line and a tall header in files that are not allowlisted, naming the line", () => {
    expect(() => checkStyle({ directory, allowlist: { lineLength: [], headerLength: ["formal/models/kernel/tall.qnt", "formal/models/fixtures/kernel/leading.qnt"] } }))
      .toThrow(/^formal\/models\/fixtures\/kernel\/wide.qnt:2: line over 120 characters$/m);
    expect(() => checkStyle({ directory, allowlist: { lineLength: ["formal/models/fixtures/kernel/wide.qnt"], headerLength: ["formal/models/fixtures/kernel/leading.qnt"] } }))
      .toThrow(/tall.qnt: module header has 26 comment lines \(cap 25\)/);
    expect(() => checkStyle({ directory, allowlist: { lineLength: ["formal/models/fixtures/kernel/wide.qnt"], headerLength: ["formal/models/kernel/tall.qnt"] } }))
      .toThrow(/leading.qnt: module header has 27 comment lines/);
  });

  it("fails a stale entry for either rule, a file outside the scope, and reports both when a file offends the other rule only", () => {
    const base = { lineLength: ["formal/models/fixtures/kernel/wide.qnt"], headerLength: ["formal/models/kernel/tall.qnt", "formal/models/fixtures/kernel/leading.qnt"] };
    expect(() => checkStyle({ directory, allowlist: { ...base, lineLength: [...base.lineLength, "formal/models/clean.qnt"] } }))
      .toThrow(/clean.qnt has no line over 120; delete its lineLength entry/);
    expect(() => checkStyle({ directory, allowlist: { ...base, headerLength: [...base.headerLength, "formal/models/clean.qnt"] } }))
      .toThrow(/clean.qnt has a header within 25 lines; delete its headerLength entry/);
    expect(() => checkStyle({ directory, allowlist: { ...base, lineLength: [...base.lineLength, "typescript/test/fixtures/missing.qnt"] } }))
      .toThrow(/names a file that is not a Quint source under formal\/models: typescript\/test\/fixtures\/missing.qnt/);
    const swapped = () => checkStyle({ directory, allowlist: { lineLength: ["formal/models/kernel/tall.qnt", "formal/models/fixtures/kernel/leading.qnt"], headerLength: ["formal/models/fixtures/kernel/wide.qnt"] } });
    expect(swapped).toThrow(/tall.qnt has no line over 120/);
    expect(swapped).toThrow(/tall.qnt: module header has 26 comment lines/);
    expect(swapped).toThrow(/wide.qnt:2: line over 120 characters/);
  });

  it("measures the header on both sides of the module line, stopping at the first import or definition", () => {
    expect(headerLines(["module m {", "  // a", "", "  // b", "  import x.* from \"./x\"", "  // not header", "}"])).toBe(2);
    expect(headerLines(["// one", "// two", "module m {", "  // three", "  pure val x = 1"])).toBe(3);
    expect(headerLines(["// file comment", "", "pure val before = 1", "// not adjacent", "module m {", "  pure val x = 1"])).toBe(1);
    expect(headerLines(["pure val x = 1"])).toBe(0);
  });

  it("scans definitions to the matching parenthesis and counts boolean parameters anywhere", () => {
    const found = definitions('pure def f(a: int, b: bool, c: int, d: bool) = a\naction g(x: bool, y: bool): bool = true\npure def k(step: (int, int) => int, v: bool) = v');
    expect(found.map(d => [d.name, d.params.length])).toEqual([["f", 4], ["g", 2], ["k", 2]]);
    expect(found[2]!.params[0]).toBe("step: (int, int) => int");
  });

  it("reports the measurements the readability plan tracks", () => {
    const m = measure(directory);
    expect(m).toMatchObject({ files: 5, linesOver: { total: 1, fixtures: 1 }, headers: { longest: 27, overCap: 2 }, exclusionReasons: 1 });
    expect(m.commentSentences).toMatchObject({ over40: 1 });
    expect(m.commentSentences.longest).toBeLessThan(60);
    expect(m.guideSentences).toMatchObject({ over40: 1 });
    expect(m.definitions).toMatchObject({ count: 4, sixOrMoreParameters: { models: 1, kernel: 0, fixtures: 0 }, twoBooleanParameters: ["defs.qnt:f", "defs.qnt:g"] });
    const report = renderReport(m);
    expect(report).toContain(`| Lines over ${caps.lineLength} characters (models / kernel / fixtures) | 1 (0 / 0 / 1) |`);
    expect(report).toContain("| Free-text exclusion reasons in execution.json | 1 |");
    expect(report).toContain("defs.qnt:f, defs.qnt:g");
  });

  it("holds on the committed tree and runs in the audit lane", () => {
    const result = checkStyle();
    expect(result.files).toBeGreaterThan(50);
    expect(measure().headers.overCap).toBe(2);
    expect(validationPlan("audit", { directory: root }).some(step => step.args?.[0] === "formal/tools/check-style.mjs")).toBe(true);
  });
});
