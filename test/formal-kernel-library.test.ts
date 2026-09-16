import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { checkKernelFixtures, kernelFixtures } from "../formal/check-kernel-fixtures.mjs";

// The kernel library's transitions are pure, so their behavior is exercised by
// small profiles under test/fixtures/kernel: each typechecks and its runs pass.
// The same check is a step of the model-check and differential lanes
// (formal/validation.mjs), where Quint is installed; here it runs when Quint
// is on the developer's PATH.
const quintAvailable = spawnSync("quint", ["--version"], { encoding: "utf8" }).status === 0;

describe("kernel library fixtures", () => {
  it("lists the held-replies fixture", () => {
    expect(kernelFixtures()).toContain("test/fixtures/kernel/held-replies.qnt");
  });

  it.skipIf(!quintAvailable)("typechecks and passes every run of every fixture", async () => {
    const declared = kernelFixtures().reduce((count, model) => count + (readFileSync(model, "utf8").match(/^\s*run\s+\w+/gm) ?? []).length, 0);
    const result = await checkKernelFixtures();
    expect(result.fixtures).toBe(kernelFixtures().length);
    expect(result.runs).toBe(declared);
  }, 300_000);
});
