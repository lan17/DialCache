import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { checkCourse, citations, quotedCounts } = await import(
  new URL("../../formal/tools/check-course.mjs", import.meta.url).href,
) as {
  checkCourse(options?: { directory?: string; inventory?: Record<string, number> }): { lessons: number; citations: number; counts: number };
  citations(text: string): Array<{ citation: string; start: number; end: number; file?: string; tokens: string[] }>;
  quotedCounts(text: string): Array<{ key: string; value: number }>;
};
const { validationPlan } = await import(new URL("../../formal/tools/validation.mjs", import.meta.url).href) as {
  validationPlan(target: string, options: { directory: string }): Array<{ args?: string[] }>;
};
const root = fileURLToPath(new URL("../../", import.meta.url));

describe("course citations and quoted counts", () => {
  let directory: string;
  const inventory = { models: 3, regressions: 40 };
  const lesson = (text: string) => writeFileSync(join(directory, "formal/guides/course/01-a.md"), text);
  const good = [
    "# 1. A lesson (10 min)",
    "",
    "- **[sample.mjs](../../tools/sample.mjs)**, lines 2 to 3: the `second` and `third` definitions. Line 4 (`fourth`).",
    "- Read [line 1](../../tools/sample.mjs) of the file (`first`).",
    "- [sample.mjs](../../tools/sample.mjs) again: `second` (line 2).",
    "",
    "```sh",
    "node formal/tools/execution.mjs",
    "```",
    "",
    'You should see `"models": 3` and `"regressions": 40`.',
    "",
  ].join("\n");

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dialcache-course-"));
    mkdirSync(join(directory, "formal/guides/course"), { recursive: true });
    mkdirSync(join(directory, "formal/tools"), { recursive: true });
    writeFileSync(join(directory, "formal/tools/sample.mjs"), ["export const first = 1;", "export const second = 2;", "export const third = 3;", "export const fourth = 4;", ""].join("\n"));
    lesson(good);
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("parses citations with their file, range and symbols", () => {
    const found = citations(good);
    expect(found.map(c => [c.citation, c.start, c.end, c.file, c.tokens])).toEqual([
      ["lines 2 to 3", 2, 3, "../../tools/sample.mjs", ["second", "third"]],
      ["Line 4", 4, 4, "../../tools/sample.mjs", ["fourth"]],
      ["line 1", 1, 1, "../../tools/sample.mjs", ["first"]],
      ["line 2", 2, 2, "../../tools/sample.mjs", ["second"]],
    ]);
    expect(quotedCounts(good)).toEqual([{ key: "models", value: 3 }, { key: "regressions", value: 40 }]);
  });

  it("passes a lesson whose citations and counts are current", () => {
    expect(checkCourse({ directory, inventory })).toEqual({ lessons: 1, citations: 4, counts: 2 });
  });

  it("fails when the symbol is no longer on the cited lines", () => {
    lesson(good.replace("lines 2 to 3: the `second`", "lines 1 to 1: the `second`"));
    expect(() => checkCourse({ directory, inventory })).toThrow(/none of `second`, `third` appears on those lines/);
  });

  it("fails a citation without a symbol, without a file, or past the end of the file", () => {
    lesson(good.replace("Line 4 (`fourth`).", "Line 4 says more."));
    expect(() => checkCourse({ directory, inventory })).toThrow(/no backticked symbol/);
    lesson(good.replace("Read [line 1](../../tools/sample.mjs) of the file (`first`).", "Read line 1 of the file (`first`)."));
    expect(() => checkCourse({ directory, inventory })).toThrow(/no file link before the citation/);
    lesson(good.replace("Line 4 (`fourth`).", "Line 9 (`fourth`)."));
    expect(() => checkCourse({ directory, inventory })).toThrow(/has 5 lines/);
  });

  it("fails a quoted count the inventory no longer prints", () => {
    expect(() => checkCourse({ directory, inventory: { models: 3, regressions: 41 } })).toThrow(/quotes "regressions": 40; the inventory prints 41/);
  });

  it("ignores fenced code when reading citations and a missing course directory", () => {
    lesson("```sh\nsed -n 'lines 1 to 9' nothing\n```\n");
    expect(checkCourse({ directory, inventory })).toEqual({ lessons: 1, citations: 0, counts: 0 });
    rmSync(join(directory, "formal/guides/course"), { recursive: true });
    expect(checkCourse({ directory, inventory })).toEqual({ lessons: 0, citations: 0, counts: 0 });
  });

  it("runs in the audit lane", () => {
    const steps = validationPlan("audit", { directory: root });
    expect(steps.some(step => step.args?.includes("formal/tools/check-course.mjs"))).toBe(true);
  });
});
