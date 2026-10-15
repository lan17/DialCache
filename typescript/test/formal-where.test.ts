import { describe, expect, it } from "vitest";

const { lookup, render, cites, parseArguments } = await import(new URL("../../formal/tools/where.mjs", import.meta.url).href) as {
  lookup(query: string): {
    id: string; case: string | null; caseRule: string | null; obligation: string; contractsLine: number;
    quint: Array<{ path: string; line: number; text: string }>;
    cases: Array<{ id: string; scenarios: string[]; models: string[]; witnesses: string[]; provenance: string[] }>;
    nativeCases: Array<{ id: string; tests: string[] }>;
    disposed: Array<{ path: string; title: string }>;
    challenges: Array<{ id: string; mutant?: string; mutantCase?: string; tag?: string; crossContract?: string; native?: string }>;
    mutants: Array<{ id: string; case: string; ports: string[] }>; parity: Array<{ id: string }>;
  };
  render(result: unknown): string;
  cites(line: string, id: string): boolean;
  parseArguments(args: string[]): { query: string; json: boolean };
};

describe("contract lookup", () => {
  it("finds where C45 is stated, tested, challenged and mapped from the catalogs", () => {
    const result = lookup("C45");
    expect(result.case).toBeNull();
    expect(result.obligation).toMatch(/^Recheck age before\/after asynchronous decode/);
    expect(result.quint.map(cite => cite.path)).toContain("formal/models/kernel/recovery.qnt");
    expect(result.quint.every(cite => !cite.path.includes("/fixtures/"))).toBe(true);
    expect(result.cases.map(entry => entry.id)).toContain("C45.recheck-after-decode");
    expect(result.cases.every(entry => entry.scenarios.length + entry.models.length + entry.witnesses.length > 0)).toBe(true);
    expect(result.cases.some(entry => entry.provenance.length > 0)).toBe(true);
    expect(result.challenges.map(challenge => challenge.id)).toContain("recovery-inclusive-maximum");
    expect(result.challenges.find(challenge => challenge.id === "recovery-future-candidate")).toMatchObject({ mutant: "M40", mutantCase: "C40.future-rejected", tag: "cross-contract via M40 on C40.future-rejected" });
    expect(result.mutants.find(mutant => mutant.id === "M01")?.ports).toEqual(["typescript", "go", "rust"]);
    expect(result.parity.map(row => row.id)).toEqual(result.cases.map(entry => entry.id));
    expect(result.disposed.length).toBeGreaterThan(0);
  });

  it("selects mutants by the cases that carry the contract, so a cross-listed case keeps its mutant", () => {
    const result = lookup("C33");
    expect(result.cases.map(entry => entry.id)).toContain("W04.strict-fence");
    expect(result.mutants.map(mutant => mutant.id)).toContain("M06");
    for (const challenge of result.challenges) if (challenge.mutant && !challenge.tag) expect(result.mutants.map(mutant => mutant.id), challenge.id).toContain(challenge.mutant);
  });

  it("narrows to one semantic case and keeps unlinkable challenges with a tag", () => {
    const narrowed = lookup("C45.maximum-age-exclusive");
    expect(narrowed.case).toBe("C45.maximum-age-exclusive");
    expect(narrowed.caseRule).toMatch(/exactly M preserves the source error/);
    expect(narrowed.cases.map(entry => entry.id)).toEqual(["C45.maximum-age-exclusive"]);
    expect(narrowed.mutants.map(mutant => mutant.id)).toEqual(["M01"]);
    const linked = narrowed.challenges.filter(challenge => !challenge.tag);
    expect(linked).toHaveLength(4);
    expect(linked.every(challenge => challenge.mutant === "M01")).toBe(true);
    expect(lookup("C45.rollback-future").challenges.map(challenge => [challenge.id, challenge.tag])).toContainEqual(["recovery-future-candidate", "cross-contract via M40 on C40.future-rejected"]);
    const modelOnly = lookup("C24").challenges.filter(challenge => !challenge.mutant);
    expect(modelOnly.length).toBeGreaterThan(0);
    const firstCase = lookup("C24").cases[0]!.id;
    expect(lookup(firstCase).challenges.filter(challenge => !challenge.mutant).map(challenge => challenge.tag)).toEqual(modelOnly.map(challenge => `${challenge.native}, not narrowed to a case`));
  });

  it("cites ranges and whole tokens, not prefixes", () => {
    expect(cites("// Stale-on-error recovery (C40 to C46, C57)", "C42")).toBe(true);
    expect(cites("// Selected rules from C40-C45.", "C43")).toBe(true);
    expect(cites("// Selected rules from C40-C45.", "C46")).toBe(false);
    expect(cites("// judged once (C43/C45)", "C45")).toBe(true);
    expect(cites("// C450 and C4 and C455 only", "C45")).toBe(false);
    expect(cites("// W01 to W03", "C02")).toBe(false);
    expect(lookup("C42").quint.map(cite => cite.path)).toContain("formal/models/kernel/recovery.qnt");
  });

  it("lists native cases and their port tests for a binding contract", () => {
    const result = lookup("B01");
    expect(result.cases).toEqual([]);
    expect(result.nativeCases.map(entry => entry.id)).toContain("B01.registration-and-policy-snapshot");
    expect(result.nativeCases.every(entry => entry.tests.length > 0)).toBe(true);
    expect(lookup("B01.registration-and-policy-snapshot").nativeCases.map(entry => entry.id)).toEqual(["B01.registration-and-policy-snapshot"]);
  });

  it("renders the four sections with clickable locations", () => {
    const text = render(lookup("C45"));
    for (const heading of ["Stated", "Tested (", "Challenged (", "Mapped ("]) expect(text).toContain(`\n${heading}`);
    expect(text).toMatch(/formal\/guides\/CONTRACTS\.md:\d+/);
    expect(text).toMatch(/formal\/models\/kernel\/recovery\.qnt:\d+/);
    expect(text).toContain("cross-contract: ");
    expect(render(lookup("C45.maximum-age-exclusive"))).toMatch(/^C45\.maximum-age-exclusive: After asynchronous decoding/);
  });

  it("rejects an unknown contract, a malformed query, an unknown case and bad arguments", () => {
    expect(() => lookup("C99")).toThrow(/not a contract in formal\/guides\/CONTRACTS.md/);
    expect(() => lookup("recovery")).toThrow(/expected a contract ID/);
    expect(() => lookup("C45.not-a-case")).toThrow(/not a semantic case .* nor a native case/);
    expect(parseArguments(["C45", "--json"])).toEqual({ query: "C45", json: true });
    for (const args of [[], ["C45", "C46"], ["C45", "--jsonx"], ["--json"]]) expect(() => parseArguments(args)).toThrow(/Usage/);
  });
});
