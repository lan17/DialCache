import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type Entry = { title: string };
type Snapshot = { path: string; sha256: string; entries: Entry[] };
type Review = { kind: string; scope: string; contracts?: string[]; revisions?: string[] };
type Guide = Snapshot & { review?: Review };
type Audit = {
  schemaVersion: number;
  sources: Array<Omit<Snapshot, "entries"> & { entries: Array<Entry & { contracts: string[] }> }>;
  reviewedGuides: Guide[];
};
type Change = { path: string; action: string; entries?: number; pending?: string[]; dropped?: string[]; review?: boolean };
const { sourceSnapshot, guideSnapshot, checkSourceAudit, refreshSourceAudit, describeChange, encodeAudit, dispositionDigest } = await import(
  new URL("../../formal/tools/check-source-audit.mjs", import.meta.url).href,
) as {
  sourceSnapshot(directory: string): Snapshot[];
  guideSnapshot(directory: string): Snapshot[];
  checkSourceAudit(audit?: unknown, options?: { directory: string }): unknown;
  refreshSourceAudit(audit: Audit, paths: string[], options?: { directory: string }): { audit: Audit; changes: Change[] };
  describeChange(change: Change): string;
  encodeAudit(audit: unknown): string;
  dispositionDigest(audit: unknown): string;
};

describe("reviewed documentation freshness", () => {
  let directory: string;
  let audit: Audit;
  const put = (path: string, text: string) => writeFileSync(join(directory, path), text);
  const guide = (path = "formal/guides/PORTING.md") => audit.reviewedGuides.find(entry => entry.path === path)!;
  const check = (input: unknown = audit) => checkSourceAudit(input, { directory });

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "dialcache-source-audit-"));
    for (const path of ["docs", "typescript/test", "formal/guides", "formal/catalogs", "go"]) mkdirSync(join(directory, path), { recursive: true });
    put("README.md", "# Example library\n");
    put("typescript/README.md", "# TypeScript package\n");
    put("docs/usage.md", "# Public usage\n\nReviewed behavior.\n");
    put("typescript/test/cache.test.ts", 'it("returns the value", () => {});\n');
    put("formal/guides/CONTRACTS.md", "# Contracts\n\n| C01 | Admission |\n| B01 | Native API |\n");
    put("formal/guides/PORTING.md", "# Porting\n\n## Native driver\n\nReview the real observations.\n");
    put("formal/guides/VALIDATION.md", "# Validation snapshots\n\n## Prior run\n\nAn earlier revision passed two tests.\n");
    put("formal/README.md", "# Formal model\n\nStart here.\n");
    put("go/README.md", "# Go port\n\nThe native API uses explicit contexts.\n");
    audit = {
      schemaVersion: 2,
      sources: sourceSnapshot(directory).map(source => ({ ...source,
        entries: source.entries.map(entry => ({ ...entry, contracts: ["C01"] })),
      })),
      reviewedGuides: guideSnapshot(directory).map(source => ({ ...source,
        review: source.path === "formal/guides/VALIDATION.md"
          ? { kind: "historical-evidence", scope: "A preserved prior execution with its original revision and results.", revisions: ["a".repeat(40)] }
          : source.path === "formal/guides/PORTING.md"
            ? { kind: "tooling-guide", scope: "Instructions for collecting native observations and producing reports." }
            : { kind: "contract-guide", scope: "An explanation of the public admission and binding requirements.", contracts: ["C01", "B01"] },
      })),
    };
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it("checks guides separately from public behavior mappings and preserves historical results", () => {
    expect(check()).toEqual({ sources: 4, tests: 1, sections: 3, reviewedGuides: 5, guideSections: 7 });
    guide().review = { kind: "coverage-guide", scope: "Describes finite evidence accounting without claiming all histories pass.", contracts: [] };
    put("formal/catalogs/source-audit.json", JSON.stringify(audit));
    expect(checkSourceAudit(undefined, { directory })).toMatchObject({ reviewedGuides: 5 });
  });

  it("rejects a body-only edit even when the section inventory stays unchanged", () => {
    const path = "formal/guides/PORTING.md";
    const before = readFileSync(join(directory, path), "utf8");
    put(path, before.replace("real observations", "expected model values"));
    expect(guideSnapshot(directory).find(entry => entry.path === path)!.entries).toEqual(guide(path).entries);
    expect(() => check()).toThrow(/formal\/guides\/PORTING.md: contents changed/);
    put(path, before);
    expect(check()).toMatchObject({ reviewedGuides: 5 });
  });

  it("rejects a newly added or removed guide", () => {
    put("formal/guides/NEW.md", "# New guide\n");
    expect(() => check()).toThrow(/guide file inventory/);
    rmSync(join(directory, "formal/guides/NEW.md"));
    rmSync(join(directory, "formal/guides/PORTING.md"));
    expect(() => check()).toThrow(/guide file inventory/);
  });

  it("inventories nested native guides while excluding generated documentation", () => {
    mkdirSync(join(directory, "docs/languages"));
    put("docs/languages/go.md", "# Go setup\n\nNative context lifetime.\n");
    expect(sourceSnapshot(directory).map(source => source.path)).toContain("docs/languages/go.md");
    expect(() => check()).toThrow(/Source file inventory changed/);
    rmSync(join(directory, "docs/languages"), { recursive: true });
    for (const path of ["docs/generated", "docs/public", "docs/.vitepress"]) {
      mkdirSync(join(directory, path), { recursive: true });
      put(`${path}/output.md`, "# Generated from reviewed sources\n");
    }
    expect(check()).toMatchObject({ sources: 4 });
  });

  it("requires the guide collection and rejects duplicate or extra recorded files", () => {
    const { reviewedGuides: _guides, ...missing } = audit;
    expect(() => check(missing)).toThrow(/guide file inventory/);
    for (const path of [guide().path, "formal/guides/UNREVIEWED.md"]) {
      const input = structuredClone(audit);
      input.reviewedGuides.push({ ...structuredClone(guide()), path });
      expect(() => check(input)).toThrow(/guide file inventory/);
    }
  });

  it.each([
    ["added", "# Porting\n\n## Native driver\n\n## New requirement\n"],
    ["removed", "# Porting\n\nThe driver requirement was removed.\n"],
  ])("rejects a %s section even if only the content fingerprint is refreshed", (_, text) => {
    put("formal/guides/PORTING.md", text);
    guide().sha256 = guideSnapshot(directory).find(entry => entry.path === guide().path)!.sha256;
    expect(() => check()).toThrow(/guide section inventory/);
  });

  it("rejects missing or duplicate recorded headings", () => {
    for (const mutate of [(entries: Entry[]) => entries.pop(), (entries: Entry[]) => entries.push(entries[0]!)]) {
      const input = structuredClone(audit);
      mutate(input.reviewedGuides.find(entry => entry.path === guide().path)!.entries);
      expect(() => check(input)).toThrow(/guide section inventory/);
    }
  });

  it("requires an explicit valid review and a nonblank explanation", () => {
    const missing = structuredClone(audit);
    delete missing.reviewedGuides[0]!.review;
    expect(() => check(missing)).toThrow(/review kind/);
    guide().review!.kind = "verified-everything";
    expect(() => check()).toThrow(/review kind/);
    guide().review!.kind = "tooling-guide";
    for (const scope of ["", " \n\t "]) {
      guide().review!.scope = scope;
      expect(() => check()).toThrow(/reviewed guide scope/);
    }
  });

  it("requires valid unique contract IDs without assigning behavior to tooling", () => {
    guide().review = { kind: "contract-guide", scope: "Explains admission requirements." };
    expect(() => check()).toThrow(/guide contract IDs/);
    for (const contracts of [[], ["C99"], ["C01", "C01"]]) {
      guide().review!.contracts = contracts;
      expect(() => check()).toThrow(/guide contract IDs/);
    }
    guide().review = { kind: "tooling-guide", scope: "Explains report preparation without claiming behavioral coverage.", contracts: ["C99"] };
    expect(() => check()).toThrow(/guide contract IDs/);
    delete guide().review!.contracts;
    expect(check()).toMatchObject({ reviewedGuides: 5 });
  });

  it("requires full unique revision identities for historical evidence", () => {
    const review = guide("formal/guides/VALIDATION.md").review!;
    delete review.revisions;
    expect(() => check()).toThrow(/historical revision identity/);
    for (const revisions of [[], ["a".repeat(7)], ["z".repeat(40)], ["a".repeat(40), "A".repeat(40)]]) {
      review.revisions = revisions;
      expect(() => check()).toThrow(/historical revision identity/);
    }
  });

  it("uses the same fenced-code parsing for public and formal guides", () => {
    const text = ["# Porting", "````markdown", "# Hidden", "```", "## Still hidden", "~~~~",
      "## Wrong marker", "```` trailing text", "## Invalid closer", "`````  ", "## After",
      "~~~text", "# Hidden too", "~~~", "### End"].join("\r\n");
    put("formal/guides/PORTING.md", text);
    put("docs/usage.md", text);
    const expected = [{ title: "Porting" }, { title: "After" }, { title: "End" }];
    expect(guideSnapshot(directory).find(entry => entry.path === "formal/guides/PORTING.md")!.entries).toEqual(expected);
    expect(sourceSnapshot(directory).find(entry => entry.path === "docs/usage.md")!.entries).toEqual(expected);
  });

  it("retains the existing public source freshness gate", () => {
    put("docs/usage.md", "# Public usage\n\nA changed public obligation.\n");
    expect(() => check()).toThrow(/docs\/usage.md: contents changed/);
  });

  it("refreshes a named guide's hash and headings and keeps its review record", () => {
    const path = "formal/guides/PORTING.md";
    put(path, "# Porting\n\nMore words first.\n\n## Native driver\n\nReview the real observations.\n\n## Reports\n");
    expect(() => check()).toThrow(/PORTING.md: contents changed/);
    const { audit: refreshed, changes } = refreshSourceAudit(audit, [path], { directory });
    expect(changes).toEqual([{ path, action: "refreshed", entries: 3, pending: [], dropped: [], review: true }]);
    expect(refreshed.reviewedGuides.find(entry => entry.path === path)).toEqual({
      path, sha256: guideSnapshot(directory).find(entry => entry.path === path)!.sha256,
      entries: [{ title: "Porting" }, { title: "Native driver" }, { title: "Reports" }],
      review: guide(path).review,
    });
    expect(guide(path).entries).toHaveLength(2);
    expect(checkSourceAudit(refreshed, { directory })).toMatchObject({ reviewedGuides: 5, guideSections: 8 });
  });

  it("carries contract dispositions by title and leaves a new section without one", () => {
    const path = "docs/usage.md";
    put(path, "# Public usage\n\nReviewed behavior, reworded.\n\n## Limits\n\nNew prose.\n");
    const { audit: refreshed, changes } = refreshSourceAudit(audit, [path], { directory });
    expect(changes).toEqual([{ path, action: "refreshed", entries: 2, pending: ['"Limits"'], dropped: [], review: true }]);
    expect(describeChange(changes[0]!)).toBe('docs/usage.md: refreshed, 2 entries; 1 without a contract disposition: "Limits"');
    const entries = refreshed.sources.find(source => source.path === path)!.entries;
    expect(entries).toEqual([{ title: "Public usage", contracts: ["C01"] }, { title: "Limits", contracts: [] }]);
    expect(() => checkSourceAudit(refreshed, { directory })).toThrow(/docs\/usage.md "Limits": missing, duplicate or unknown contract disposition/);
    entries[1]!.contracts = ["B01"];
    expect(checkSourceAudit(refreshed, { directory })).toMatchObject({ sections: 4 });
  });

  it("matches repeated titles by occurrence and reports a renamed title's dropped disposition", () => {
    const path = "docs/usage.md";
    audit.sources.find(source => source.path === path)!.entries = [
      { title: "Public usage", contracts: ["C01"] }, { title: "Example", contracts: ["C01"] },
      { title: "Example", contracts: ["B01"] }, { title: "Errors", contracts: ["C01"] }];
    put(path, "# Public usage\n\nInserted paragraph.\n\n## Example\n\n## Example\n\n## Failures\n");
    const { audit: refreshed, changes } = refreshSourceAudit(audit, [path], { directory });
    expect(refreshed.sources.find(source => source.path === path)!.entries).toEqual([
      { title: "Public usage", contracts: ["C01"] }, { title: "Example", contracts: ["C01"] },
      { title: "Example", contracts: ["B01"] }, { title: "Failures", contracts: [] }]);
    expect(changes).toEqual([{ path, action: "refreshed", entries: 4, pending: ['"Failures"'], dropped: ['"Errors" ["C01"]'], review: true }]);
    expect(describeChange(changes[0]!)).toBe('docs/usage.md: refreshed, 4 entries; 1 without a contract disposition: "Failures"; dropped: "Errors" ["C01"]');
  });

  it("starts every occurrence of a repeated title empty when its count changed, naming repeats by position", () => {
    const path = "docs/usage.md";
    audit.sources.find(source => source.path === path)!.entries = [
      { title: "Public usage", contracts: ["C01"] }, { title: "Example", contracts: ["C01"] }, { title: "Example", contracts: ["B01"] }];
    put(path, "# Public usage\n\n## Example\n\nNew first example.\n\n## Example\n\n## Example\n");
    const { audit: refreshed, changes } = refreshSourceAudit(audit, [path], { directory });
    expect(refreshed.sources.find(source => source.path === path)!.entries).toEqual([
      { title: "Public usage", contracts: ["C01"] }, { title: "Example", contracts: [] }, { title: "Example", contracts: [] }, { title: "Example", contracts: [] }]);
    expect(changes[0]!.pending).toEqual(['"Example" #1', '"Example" #2', '"Example" #3']);
    expect(changes[0]!.dropped).toEqual(['"Example" #1 ["C01"]', '"Example" #2 ["B01"]']);
    expect(() => checkSourceAudit(refreshed, { directory })).toThrow(/docs\/usage.md "Example" #3: missing, duplicate or unknown contract disposition/);
    put(path, "# Public usage\n\n## Example\n\n## Example\n");
    expect(refreshSourceAudit(audit, [path], { directory }).audit.sources.find(source => source.path === path)!.entries.map(entry => entry.contracts)).toEqual([["C01"], ["C01"], ["B01"]]);
  });

  it("adds a named new file at its inventory position and drops a named removed one", () => {
    put("docs/limits.md", "# Limits\n");
    rmSync(join(directory, "typescript/test/cache.test.ts"));
    expect(() => check()).toThrow(/Source file inventory changed/);
    const { audit: refreshed, changes } = refreshSourceAudit(audit, ["docs/limits.md", "typescript/test/cache.test.ts"], { directory });
    expect(changes).toEqual([
      { path: "docs/limits.md", action: "added", entries: 1, pending: ['"Limits"'], dropped: [], review: true },
      { path: "typescript/test/cache.test.ts", action: "removed" }]);
    expect(describeChange(changes[1]!)).toBe("typescript/test/cache.test.ts: removed, no longer in the inventory");
    expect(refreshed.sources.map(source => source.path)).toEqual(["README.md", "docs/limits.md", "docs/usage.md", "typescript/README.md"]);
    expect(() => checkSourceAudit(refreshed, { directory })).toThrow(/^docs\/limits.md "Limits": missing, duplicate or unknown contract disposition$/m);
  });

  it("adds a named new guide without a review record and leaves unnamed files alone", () => {
    put("formal/guides/NEW.md", "# New guide\n\n## Steps\n");
    put("docs/usage.md", "# Public usage\n\nChanged but not named.\n");
    const { audit: refreshed, changes } = refreshSourceAudit(audit, ["formal/guides/NEW.md"], { directory });
    expect(changes).toEqual([{ path: "formal/guides/NEW.md", action: "added", entries: 2, pending: [], dropped: [], review: false }]);
    expect(describeChange(changes[0]!)).toBe("formal/guides/NEW.md: added, 2 entries; its review record is missing");
    expect(refreshed.reviewedGuides.map(entry => entry.path)).toEqual(["formal/README.md", "formal/guides/CONTRACTS.md", "formal/guides/NEW.md", "formal/guides/PORTING.md", "formal/guides/VALIDATION.md", "go/README.md"]);
    expect(refreshed.reviewedGuides[2]).toEqual({ path: "formal/guides/NEW.md", sha256: expect.stringMatching(/^[a-f\d]{64}$/), entries: [{ title: "New guide" }, { title: "Steps" }] });
    expect(refreshed.sources.find(source => source.path === "docs/usage.md")).toBe(audit.sources.find(source => source.path === "docs/usage.md"));
    expect(() => checkSourceAudit(refreshed, { directory })).toThrow(/NEW.md: missing or invalid guide review kind/);
    expect(() => checkSourceAudit(refreshed, { directory })).toThrow(/docs\/usage.md: contents changed/);
  });

  it("reports an unchanged file and refuses one outside the inventory", () => {
    const { audit: same, changes } = refreshSourceAudit(audit, ["./docs/usage.md"], { directory });
    expect(changes).toEqual([{ path: "docs/usage.md", action: "unchanged", entries: 1, pending: [] }]);
    expect(describeChange(changes[0]!)).toBe("docs/usage.md: unchanged, 1 entry");
    expect(same).toEqual(audit);
    expect(() => refreshSourceAudit(audit, ["formal/models/kernel/README.md"], { directory })).toThrow(/not an audited source or reviewed guide/);
  });

  it("encodes the audit as it is committed", () => {
    const committed = readFileSync(new URL("../../formal/catalogs/source-audit.json", import.meta.url), "utf8");
    expect(encodeAudit(JSON.parse(committed))).toBe(committed);
  });

  it("keys entries by title, so prose above a heading changes only the file hash", () => {
    const path = "formal/guides/PORTING.md";
    const before = guide(path);
    put(path, "# Porting\n\nA new paragraph before the first section.\n\nAnd another.\n\n## Native driver\n\nReview the real observations.\n");
    expect(guideSnapshot(directory).find(entry => entry.path === path)!.entries).toEqual(before.entries);
    expect(() => check()).toThrow(/^formal\/guides\/PORTING.md: contents changed[^\n]*$/m);
    expect(() => check()).not.toThrow(/inventory changed/);
    const { audit: refreshed, changes } = refreshSourceAudit(audit, [path], { directory });
    expect(changes).toEqual([{ path, action: "refreshed", entries: 2, pending: [], dropped: [], review: true }]);
    const after = refreshed.reviewedGuides.find(entry => entry.path === path)!;
    expect({ ...after, sha256: before.sha256 }).toEqual(before);
    put(path, "# Porting\n\nReview the real observations.\n\n## Native driver\n\n# Porting\n");
    expect(() => check()).toThrow(/guide section inventory changed/);
  });

  it("binds the Go parity ledger to dispositions, test hashes and guide reviews, not to documentation bytes", () => {
    const base = dispositionDigest(audit);
    const vary = (mutate: (copy: Audit) => void) => { const copy = structuredClone(audit); mutate(copy); return dispositionDigest(copy); };
    expect(vary(copy => { copy.sources.find(source => source.path === "docs/usage.md")!.sha256 = "0".repeat(64); })).toBe(base);
    expect(vary(copy => { copy.reviewedGuides[0]!.sha256 = "0".repeat(64); })).toBe(base);
    expect(vary(copy => { copy.sources.find(source => source.path === "typescript/test/cache.test.ts")!.sha256 = "0".repeat(64); })).not.toBe(base);
    expect(vary(copy => { copy.sources.find(source => source.path === "docs/usage.md")!.entries[0]!.contracts = ["B01"]; })).not.toBe(base);
    expect(vary(copy => { copy.sources.find(source => source.path === "docs/usage.md")!.entries[0]!.title = "Renamed"; })).not.toBe(base);
    expect(vary(copy => { copy.sources.find(source => source.path === "docs/usage.md")!.entries.push({ title: "Limits", contracts: ["C01"] }); })).not.toBe(base);
    expect(vary(copy => { copy.reviewedGuides[0]!.review!.scope = "Reworded review scope."; })).not.toBe(base);
    expect(vary(copy => { copy.schemaVersion = 3; })).not.toBe(base);
  });
});
