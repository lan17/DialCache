import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The kernel library's transitions are pure, so their behavior is exercised by
// small profiles under test/fixtures/kernel: each typechecks and its runs pass.
// A composed conformance profile reaches the library only through its own
// wrappers; these fixtures reach the seams a profile may not use yet (held
// policy replies, release order, coalescing off, closure between admission
// and release) so a library change cannot move them unnoticed.
const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = "test/fixtures/kernel";
const quintAvailable = spawnSync("quint", ["--version"], { encoding: "utf8" }).status === 0;
const models = readdirSync(new URL(`../${fixtures}`, import.meta.url)).filter(name => name.endsWith(".qnt")).sort();

describe.skipIf(!quintAvailable)("kernel library fixtures", () => {
  it("has at least the held-replies fixture", () => {
    expect(models).toContain("held-replies.qnt");
  });

  for (const name of models) {
    it(`typechecks and passes every run of ${name}`, () => {
      const model = `${fixtures}/${name}`;
      const typecheck = spawnSync("quint", ["typecheck", model], { cwd: root, encoding: "utf8" });
      expect(typecheck.status, typecheck.stderr + typecheck.stdout).toBe(0);
      const test = spawnSync("quint", ["test", model, "--backend=rust", "--max-samples=1"], { cwd: root, encoding: "utf8" });
      expect(test.status, test.stderr + test.stdout).toBe(0);
      expect(test.stdout).toMatch(/\d+ passing/);
      expect(test.stdout).not.toMatch(/failed/);
    }, 120_000);
  }
});
