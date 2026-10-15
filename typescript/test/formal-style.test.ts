import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { checkStyle, measure, renderReport, headerLines, caps } = await import(
  new URL("../../formal/tools/check-style.mjs", import.meta.url).href,
) as {
  checkStyle(options?: { directory?: string; allowlist?: { lineLength?: string[]; headerLength?: string[] } }): { files: number; lineLengthChecked: number; allowlisted: number };
  measure(directory?: string): { files: number; linesOver: { total: number }; headers: { longest: number; overCap: number }; commentSentences: { over40: number }; definitions: { twoAdjacentBooleans: string[] }; exclusionReasons: number };
  renderReport(measurements: unknown): string;
  headerLines(lines: string[]): number;
  caps: { lineLength: number; headerLength: number };
};

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
    put("formal/guides/GUIDE.md", "# Guide\n\nShort sentence. " + "word ".repeat(45) + "ends here.\n");
    put("formal/README.md", "# Formal\n\nOne sentence.\n");
    put("formal/catalogs/execution.json", JSON.stringify({ challenges: [{ reproducer: { exclusions: { a: "free text", b: { reason: "slug" } } } }] }));
    put("formal/catalogs/style-allowlist.json", JSON.stringify({ lineLength: ["formal/models/fixtures/kernel/wide.qnt"], headerLength: ["formal/models/kernel/tall.qnt"] }));
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("passes when every offender is allowlisted and counts what it checked", () => {
    expect(checkStyle({ directory })).toEqual({ files: 3, lineLengthChecked: 2, allowlisted: 2 });
  });

  it("fails a long line and a tall header in files that are not allowlisted, naming the line", () => {
    expect(() => checkStyle({ directory, allowlist: { lineLength: [], headerLength: ["formal/models/kernel/tall.qnt"] } }))
      .toThrow(/^formal\/models\/fixtures\/kernel\/wide.qnt:2: line over 120 characters$/m);
    expect(() => checkStyle({ directory, allowlist: { lineLength: ["formal/models/fixtures/kernel/wide.qnt"], headerLength: [] } }))
      .toThrow(/tall.qnt: module header has 26 comment lines \(cap 25\)/);
  });

  it("fails a stale allowlist entry so the list only shrinks, and a missing file", () => {
    expect(() => checkStyle({ directory, allowlist: { lineLength: ["formal/models/fixtures/kernel/wide.qnt", "formal/models/clean.qnt"], headerLength: ["formal/models/kernel/tall.qnt"] } }))
      .toThrow(/clean.qnt has no line over 120; delete its lineLength entry/);
    expect(() => checkStyle({ directory, allowlist: { lineLength: ["formal/models/fixtures/kernel/wide.qnt", "formal/models/missing.qnt"], headerLength: ["formal/models/kernel/tall.qnt"] } }))
      .toThrow(/names a file that does not exist: formal\/models\/missing.qnt/);
  });

  it("measures headers from the module line to the first non-comment line", () => {
    expect(headerLines(["module m {", "  // a", "", "  // b", "  import x.* from \"./x\"", "  // not header", "}"])).toBe(2);
    expect(headerLines(["// file comment", "module m {", "  pure val x = 1"])).toBe(0);
  });

  it("reports the measurements the readability plan tracks", () => {
    const m = measure(directory);
    expect(m).toMatchObject({ files: 3, linesOver: { total: 1, fixtures: 1 }, headers: { longest: 26, overCap: 1 }, exclusionReasons: 1 });
    expect(m.commentSentences.over40).toBe(0);
    const report = renderReport(m);
    expect(report).toContain(`| Lines over ${caps.lineLength} characters (models / kernel / fixtures) | 1 (0 / 0 / 1) |`);
    expect(report).toContain("| Free-text exclusion reasons in execution.json | 1 |");
  });

  it("holds on the committed tree: every current offender is allowlisted and no allowlist entry is stale", () => {
    const result = checkStyle();
    expect(result.files).toBeGreaterThan(50);
    expect(measure().headers.overCap).toBe(0);
  });
});
