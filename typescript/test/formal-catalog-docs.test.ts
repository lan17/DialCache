import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { renderProfiles, renderChallenges, renderMutants, describeProfile, decodeWithProbes, checkCatalogDocs, views } = await import(
  new URL("../../formal/tools/generate-catalog-docs.mjs", import.meta.url).href,
) as {
  renderProfiles(options?: { directory?: string }): string;
  renderChallenges(options?: { directory?: string }): string;
  renderMutants(options?: { directory?: string }): string;
  describeProfile(id: string): { actions: Record<string, { choices?: number[] | string; decode: (choice: number, observed: unknown, environment: unknown) => unknown }>; channels: Array<{ name: string }> };
  decodeWithProbes(decode: (choice: number, observed: unknown, environment: unknown) => unknown, choice: number): { input: unknown; touched: string[] };
  checkCatalogDocs(options?: { directory?: string }): { views: number };
  views: Record<string, string>;
};
const registry = JSON.parse(readFileSync(new URL("../../formal/catalogs/profiles.json", import.meta.url), "utf8")) as { profiles: Array<{ id: string }> };
const execution = JSON.parse(readFileSync(new URL("../../formal/catalogs/execution.json", import.meta.url), "utf8")) as { challenges: Array<{ id: string; nativeMutants?: { mutant?: string } }> };
const mutations = JSON.parse(readFileSync(new URL("../../formal/catalogs/mutations.json", import.meta.url), "utf8")) as { mutations: Array<{ id: string }> };

describe("generated catalog views", () => {
  it("renders the committed views exactly, so the audit lane can check freshness without Quint", () => {
    const committed = (name: keyof typeof views) => readFileSync(new URL(`../../${views[name]}`, import.meta.url), "utf8");
    expect(renderProfiles()).toBe(committed("profiles"));
    expect(renderChallenges()).toBe(committed("challenges"));
    expect(renderMutants()).toBe(committed("mutants"));
    expect(checkCatalogDocs()).toEqual({ views: 3 });
  });

  it("indexes every challenge and every mutant in one row each and stays small", () => {
    const challenges = renderChallenges(), mutants = renderMutants();
    for (const challenge of execution.challenges) expect(challenges, challenge.id).toContain(`| \`${challenge.id}\` |`);
    for (const mutant of mutations.mutations) expect(mutants, mutant.id).toContain(`| \`${mutant.id}\` |`);
    expect(challenges.split("\n").length).toBeLessThan(execution.challenges.length + 20);
    expect(mutants.split("\n").length).toBeLessThan(mutations.mutations.length + 20);
    const mapped = execution.challenges.find(challenge => challenge.nativeMutants?.mutant === "M01")!;
    expect(mutants).toMatch(new RegExp(`\\| \`M01\` \\|.*\`${mapped.id}\``));
  });

  it("is deterministic and covers every registered profile and every descriptor action", () => {
    const rendered = renderProfiles();
    expect(renderProfiles()).toBe(rendered);
    for (const { id } of registry.profiles) {
      expect(rendered, id).toContain(`\n## ${id}\n`);
      for (const action of Object.keys(describeProfile(id).actions)) expect(rendered, `${id}.${action}`).toContain(`| \`${action}\` |`);
    }
  });

  it("decodes with probes that report what a decoder reads at the step", () => {
    const { actions } = describeProfile("recovery");
    expect(decodeWithProbes(actions.releaseLoad!.decode, 0)).toEqual({ input: { op: "release", effect: "load", index: 0 }, touched: ["observation.loads"] });
    expect(decodeWithProbes(actions.advance!.decode, 1000)).toEqual({ input: { op: "advance", ms: 1000 }, touched: [] });
    const recoveryRead = describeProfile("recovery-read");
    expect(decodeWithProbes(recoveryRead.actions.seed!.decode, 17).touched).toEqual(["environment.wallMs"]);
  });

  it("lists the observation channels a profile's descriptor declares", () => {
    expect(describeProfile("recovery-read").channels.map(channel => channel.name)).toEqual(["o", "io", "markers", "compression"]);
    expect(describeProfile("policy").channels.map(channel => channel.name)).toEqual(["o", "policyErrors"]);
    expect(describeProfile("core").channels.map(channel => channel.name)).toEqual(["o"]);
  });
});
