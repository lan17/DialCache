import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// Optional measurement output. Expected observations never enter the driver.
// A baseline run must pass all replays as well as these reachability checks.
export function recordWitnesses(profile: string, seen: Set<string>, required: string[], traces: number): void {
  const directory = process.env.DIALCACHE_COVERAGE_EVIDENCE_DIR;
  if (directory === undefined) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, `${profile}.json`), JSON.stringify({ profile, traces, required, seen: [...seen].sort() }, null, 2) + "\n");
}
