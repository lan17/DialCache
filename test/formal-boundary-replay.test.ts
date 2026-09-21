import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { boundaryBaselines, boundaryTrace, goBoundarySelection, mutationBoundaries, readBoundaryRecording, type BoundaryRecording } from "../formal/boundary-replay.mjs";

const directory = mkdtempSync(resolve(tmpdir(), "dialcache-boundary-test-"));
const file = resolve(directory, "recordings.jsonl");
const history = "shadow-layers/capturedRetentionTest";
const path = boundaryTrace(history, directory).path;
const packet = { path, completed: true, lastStep: 7, divergences: [{ step: 7, action: "releaseWrite", paths: ["o.writeTtls.0"] }] };
afterEach(() => rmSync(file, { force: true }));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("boundary replay evidence", () => {
  it.each([
    ["core", "TestCoreConformance", "DIALCACHE_MBT_TRACE_FILE"],
    ["effects", "TestEffectsConformance", "DIALCACHE_EFFECTS_TRACE_FILE"],
    ["local-clock", "TestLocalClockConformance", "DIALCACHE_FEATURE_TRACE_FILE"],
    ["shadow-layers", "TestFeatureConformance", "DIALCACHE_FEATURE_TRACE_FILE"],
  ])("selects only the %s history through its native Go driver", (profile, name, selector) => {
    const selection = goBoundarySelection(profile, path);
    expect(selection.test).toBe(name);
    expect(selection.env[selector]).toBe(path);
    expect(Object.entries(selection.env).filter(([key]) => key.endsWith("_DIR")).every(([, value]) => value === "")).toBe(true);
    expect(Object.values(selection.env).filter(Boolean)).toEqual([path]);
  });

  it("requires exactly one terminal recording of the selected file", () => {
    for (const value of ["", "not json", JSON.stringify({ ...packet, path: "/another/history.itf.json" }),
      JSON.stringify({ ...packet, lastStep: -1, divergences: [] }), JSON.stringify({ ...packet, divergences: [...packet.divergences, ...packet.divergences] }),
      `${JSON.stringify(packet)}\n${JSON.stringify(packet)}`]) {
      writeFileSync(file, value);
      expect(readBoundaryRecording(file, history, path, { status: 0 })).toMatchObject({ completed: false, lastStep: -1, error: expect.stringContaining("recording unavailable") });
    }
  });

  it("does not credit an early divergence after driver or native cleanup failure", () => {
    writeFileSync(file, JSON.stringify(packet));
    expect(readBoundaryRecording(file, history, path, { status: 0 })).toMatchObject({ completed: true, divergences: packet.divergences });
    const output = JSON.stringify({ Output: "    feature_replay_test.go:84: No pending dump 0\n" });
    expect(readBoundaryRecording(file, history, path, { status: 1, stdout: output })).toMatchObject({
      completed: false, divergences: packet.divergences, error: expect.stringContaining("No pending dump 0"),
    });
    writeFileSync(file, JSON.stringify({ ...packet, completed: false, error: "step 8 releaseDump: Settlement violation: runnable task" }));
    expect(readBoundaryRecording(file, history, path, { status: 1 })).toMatchObject({
      completed: false, divergences: packet.divergences, error: expect.stringContaining("step 8 releaseDump: Settlement violation"),
    });
  });

  it("requires clean complete baselines and replays shared histories once per mutant", () => {
    const entries = [{ challenge: "one", history }, { challenge: "two", history }, { challenge: "backlog" }];
    const baseline: BoundaryRecording = { ...packet, history, via: "coordinator", divergences: [] };
    const replay = vi.fn(() => baseline);
    expect(boundaryBaselines(entries, replay)).toEqual({ [history]: baseline });
    expect(replay).toHaveBeenCalledOnce();
    const assess = vi.fn((entry: typeof entries[number], record?: BoundaryRecording) => ({ challenge: entry.challenge, record }));
    replay.mockClear();
    expect(mutationBoundaries(entries, replay, assess)).toHaveLength(3);
    expect(replay).toHaveBeenCalledOnce();
    expect(assess).toHaveBeenLastCalledWith(entries[2], undefined);
    expect(() => boundaryBaselines(entries, () => ({ ...baseline, divergences: packet.divergences }))).toThrow(/zero divergences/);
    expect(() => boundaryBaselines(entries, () => ({ ...baseline, completed: false, error: "driver failure" }))).toThrow(/driver failure/);
  });

  it("refuses histories that escape the regression tree", () => {
    for (const value of ["../other", "scope/../test", "scope/run.json", "scope//run"]) expect(() => boundaryTrace(value)).toThrow(/Invalid boundary history/);
  });
});
