import { describe, expect, it } from "vitest";

const { lookup, render } = await import(new URL("../../formal/tools/where.mjs", import.meta.url).href) as {
  lookup(query: string): {
    id: string; case?: string; obligation: string; contractsLine: number;
    quint: Array<{ path: string; line: number; text: string }>;
    cases: Array<{ id: string; scenarios: string[]; models: string[]; witnesses: string[] }>;
    disposed: Array<{ path: string; title: string }>; challenges: Array<{ id: string; mutant?: string }>;
    mutants: Array<{ id: string; ports: string[] }>; parity: Array<{ id: string }>;
  };
  render(result: unknown): string;
};

describe("contract lookup", () => {
  it("finds where C45 is stated, tested, challenged and mapped from the catalogs", () => {
    const result = lookup("C45");
    expect(result.obligation).toMatch(/^Recheck age before\/after asynchronous decode/);
    expect(result.quint.map(cite => cite.path)).toContain("formal/models/kernel/recovery.qnt");
    expect(result.cases.map(entry => entry.id)).toContain("C45.recheck-after-decode");
    expect(result.cases.every(entry => entry.scenarios.length + entry.models.length + entry.witnesses.length > 0)).toBe(true);
    expect(result.challenges.map(challenge => challenge.id)).toContain("recovery-inclusive-maximum");
    expect(result.mutants.find(mutant => mutant.id === "M01")?.ports).toEqual(["typescript", "go", "rust"]);
    expect(result.parity.map(row => row.id)).toEqual(result.cases.map(entry => entry.id));
    expect(result.disposed.length).toBeGreaterThan(0);
  });

  it("narrows to one semantic case and keeps the challenges mapped through its mutant", () => {
    const result = lookup("C45.maximum-age-exclusive");
    expect(result.case).toBe("C45.maximum-age-exclusive");
    expect(result.cases.map(entry => entry.id)).toEqual(["C45.maximum-age-exclusive"]);
    expect(result.mutants.map(mutant => mutant.id)).toEqual(["M01"]);
    expect(result.challenges.map(challenge => challenge.mutant)).toEqual(result.challenges.map(() => "M01"));
  });

  it("renders the four sections with clickable locations", () => {
    const text = render(lookup("C45"));
    for (const heading of ["Stated", "Tested (", "Challenged (", "Mapped ("]) expect(text).toContain(`\n${heading}`);
    expect(text).toMatch(/formal\/guides\/CONTRACTS\.md:\d+/);
    expect(text).toMatch(/formal\/models\/kernel\/recovery\.qnt:\d+/);
  });

  it("rejects an unknown contract, a malformed query and an unknown case", () => {
    expect(() => lookup("C99")).toThrow(/not a contract in formal\/guides\/CONTRACTS.md/);
    expect(() => lookup("recovery")).toThrow(/expected a contract ID/);
    expect(() => lookup("C45.not-a-case")).toThrow(/not a semantic case/);
  });
});
