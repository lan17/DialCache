import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { renderProfiles, describeProfile, decodeWithProbes, checkCatalogDocs, views } = await import(
  new URL("../../formal/tools/generate-catalog-docs.mjs", import.meta.url).href,
) as {
  renderProfiles(options?: { directory?: string }): string;
  describeProfile(id: string): { actions: Record<string, { choices?: number[] | string; decode: (choice: number, observed: unknown, environment: unknown) => unknown }>; channels: Array<{ name: string }> };
  decodeWithProbes(decode: (choice: number, observed: unknown, environment: unknown) => unknown, choice: number): { input: unknown; touched: string[] };
  checkCatalogDocs(options?: { directory?: string }): { views: number };
  views: Record<string, string>;
};
const registry = JSON.parse(readFileSync(new URL("../../formal/catalogs/profiles.json", import.meta.url), "utf8")) as { profiles: Array<{ id: string }> };

describe("generated catalog views", () => {
  it("renders the committed PROFILES.md exactly, so the audit lane can check freshness without Quint", () => {
    const committed = readFileSync(new URL(`../../${views.profiles}`, import.meta.url), "utf8");
    expect(renderProfiles()).toBe(committed);
    expect(checkCatalogDocs()).toEqual({ views: 1 });
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
