import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { it } from "vitest";

import { boundaryTrace } from "../formal/boundary-replay.mjs";
import { ReplayCoordinator, type ReplayRecording } from "../formal/replay/coordinator.mjs";
import { replayThroughCoordinator } from "./formal/coordinated-replay.js";

const history = process.env.DIALCACHE_BOUNDARY_HISTORY;

// The mutation runner judges the recorded comparisons. A driver, settlement,
// or cleanup failure still fails this test and makes the evidence unreached.
it.runIf(history !== undefined)("records the selected boundary history", async () => {
  const out = process.env.DIALCACHE_BOUNDARY_OUT;
  if (!out) throw new Error("DIALCACHE_BOUNDARY_OUT is required for a boundary replay");
  const traces = process.env.DIALCACHE_FEATURE_TRACE_DIR
    ? resolve(process.env.DIALCACHE_FEATURE_TRACE_DIR, "..") : resolve(".formal-traces");
  const { profile, path } = boundaryTrace(history!, traces);
  let recording: ReplayRecording = { path, divergences: [], completed: false, lastStep: -1 };
  const coordinator = new ReplayCoordinator({ record: true, onRecord: record => { recording = record; } });
  try {
    await replayThroughCoordinator(profile, path, coordinator);
  } catch (error) {
    recording = { ...recording, completed: false, error: String(error) };
    throw error;
  } finally {
    writeFileSync(out, JSON.stringify({ history, via: "coordinator", ...recording }) + "\n");
  }
}, 30_000);
