import { describe, expect, it, vi } from "vitest";

import { CacheLayer, DialCacheKey, DialCacheKeyConfig, type ShadowConfig } from "../src/index.js";
import { hasUnknownKeyConfigFields } from "../src/config.js";
import {
  expandMismatchLogging,
  fetchKeyConfig,
  resolveMismatchLogging,
  resolveRemoteLayerConfigResult,
} from "../src/internal/runtime-config.js";

const key = (defaultConfig: DialCacheKeyConfig | null = DialCacheKeyConfig.enabled(60)) =>
  new DialCacheKey({ keyType: "user_id", id: "123", useCase: "ObservabilityInternals", defaultConfig });
const ignoreUnknownFields = (): void => undefined;

/** The shadow group fetchKeyConfig merges from one default and one runtime shadow group. */
async function mergedShadow(
  defaultShadow: ShadowConfig | undefined,
  runtimeShadow: ShadowConfig,
): Promise<ShadowConfig> {
  const merged = await fetchKeyConfig(
    async () => new DialCacheKeyConfig({ shadow: runtimeShadow }),
    key(new DialCacheKeyConfig(defaultShadow === undefined ? {} : { shadow: defaultShadow })),
    ignoreUnknownFields,
  );
  if (merged?.shadow === undefined) {
    throw new Error("expected a merged shadow group");
  }
  return merged.shadow;
}

describe("DialCache observability internal compatibility paths", () => {
  it("merges every runtime policy leaf independently", async () => {
    const defaultConfig = new DialCacheKeyConfig({
      requestLocal: true,
      coalesce: false,
      ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 120 },
      ramp: { [CacheLayer.LOCAL]: 25, [CacheLayer.REMOTE]: 50 },
      shadow: {
        ramp: 20,
        logMismatches: true,
      },
      staleOnErrorMaxAgeSec: 3_600,
    });
    const cases = [
      {
        runtime: new DialCacheKeyConfig({
          requestLocal: false,
          coalesce: true,
          ttlSec: { [CacheLayer.LOCAL]: 30 },
          ramp: { [CacheLayer.REMOTE]: 75 },
          shadow: { ramp: 80 },
        }),
        expected: new DialCacheKeyConfig({
          requestLocal: false,
          coalesce: true,
          ttlSec: { [CacheLayer.LOCAL]: 30, [CacheLayer.REMOTE]: 120 },
          ramp: { [CacheLayer.LOCAL]: 25, [CacheLayer.REMOTE]: 75 },
          shadow: {
            ramp: 80,
            mismatchLogging: { value: true, diff: "values" },
          },
          staleOnErrorMaxAgeSec: 3_600,
        }),
      },
      {
        runtime: new DialCacheKeyConfig({
          ttlSec: { [CacheLayer.REMOTE]: 90 },
          ramp: { [CacheLayer.LOCAL]: 10 },
          shadow: {
            logMismatches: false,
          },
          staleOnErrorMaxAgeSec: 0,
        }),
        expected: new DialCacheKeyConfig({
          requestLocal: true,
          coalesce: false,
          ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 90 },
          ramp: { [CacheLayer.LOCAL]: 10, [CacheLayer.REMOTE]: 50 },
          shadow: {
            ramp: 20,
            mismatchLogging: { value: false, diff: "off" },
          },
          staleOnErrorMaxAgeSec: 0,
        }),
      },
      {
        runtime: new DialCacheKeyConfig({ shadow: {}, staleOnErrorMaxAgeSec: 7_200 }),
        expected: new DialCacheKeyConfig({
          requestLocal: true,
          coalesce: false,
          ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 120 },
          ramp: { [CacheLayer.LOCAL]: 25, [CacheLayer.REMOTE]: 50 },
          shadow: {
            ramp: 20,
            mismatchLogging: { value: true, diff: "values" },
          },
          staleOnErrorMaxAgeSec: 7_200,
        }),
      },
    ];

    for (const { runtime, expected } of cases) {
      const merged = await fetchKeyConfig(async () => runtime, key(defaultConfig), ignoreUnknownFields);

      expect(merged).toEqual(expected);
      // Each layer's shorthand expands before the merge, so only leaves remain.
      expect(merged?.shadow).not.toHaveProperty("logMismatches");
    }
  });

  it("preserves omitted requestLocal and coalesce through a runtime merge", async () => {
    // The gates own the effective defaults, so the merge must not materialize
    // either boolean when both sides omit it.
    const defaultConfig = new DialCacheKeyConfig({
      ttlSec: { [CacheLayer.LOCAL]: 60 },
      ramp: { [CacheLayer.LOCAL]: 100 },
    });
    const runtime = new DialCacheKeyConfig({ ramp: { [CacheLayer.LOCAL]: 50 } });

    const merged = await fetchKeyConfig(async () => runtime, key(defaultConfig), ignoreUnknownFields);

    expect(merged?.requestLocal).toBeUndefined();
    expect(merged?.coalesce).toBeUndefined();
    expect(merged?.ramp[CacheLayer.LOCAL]).toBe(50);
  });

  it.each([
    [
      "a runtime true shorthand beside value: false",
      undefined,
      { logMismatches: true, mismatchLogging: { value: false } },
      { value: false, diff: "values" },
    ],
    [
      "a default true shorthand beside value: false",
      { logMismatches: true, mismatchLogging: { value: false } },
      {},
      { value: false, diff: "values" },
    ],
    [
      "a runtime false shorthand beside diff: paths",
      undefined,
      { logMismatches: false, mismatchLogging: { diff: "paths" } },
      { value: false, diff: "paths" },
    ],
    [
      "a default false shorthand beside diff: paths",
      { logMismatches: false, mismatchLogging: { diff: "paths" } },
      {},
      { value: false, diff: "paths" },
    ],
    [
      "a runtime false shorthand over a default diff: paths",
      { mismatchLogging: { diff: "paths" } },
      { logMismatches: false },
      { value: false, diff: "off" },
    ],
    [
      "a runtime true shorthand over a default value: false",
      { mismatchLogging: { value: false } },
      { logMismatches: true },
      { value: true, diff: "values" },
    ],
  ] as const)("resolves %s to the recorded effective leaves", async (_name, defaultShadow, runtimeShadow, effective) => {
    const shadow = await mergedShadow(defaultShadow, runtimeShadow);

    expect(shadow).not.toHaveProperty("logMismatches");
    expect(resolveMismatchLogging(shadow)).toEqual({ ...effective, invalid: false });
  });

  it("inherits an omitted mismatchLogging leaf from the default", async () => {
    const shadow = await mergedShadow(
      { mismatchLogging: { value: true, diff: "paths" } },
      { mismatchLogging: { diff: "values" } },
    );

    expect(shadow).toEqual({ mismatchLogging: { value: true, diff: "values" } });
    expect(resolveMismatchLogging(shadow)).toEqual({ value: true, diff: "values", invalid: false });
  });

  it("lets a runtime mismatchLogging leaf override its default leaf", async () => {
    await expect(mergedShadow(
      { mismatchLogging: { value: true, diff: "values" } },
      { mismatchLogging: { value: false } },
    )).resolves.toEqual({ mismatchLogging: { value: false, diff: "values" } });
    // A default shorthand is a baseline like any other pair of default leaves.
    await expect(mergedShadow(
      { logMismatches: true },
      { mismatchLogging: { diff: "paths" } },
    )).resolves.toEqual({ mismatchLogging: { value: true, diff: "paths" } });
  });

  it("keeps a malformed runtime logMismatches for admission while its same-object leaves win", async () => {
    const shadow = await mergedShadow(
      { mismatchLogging: { value: false, diff: "values" } },
      { logMismatches: "yes" as unknown as boolean, mismatchLogging: { value: true } },
    );

    // The malformed shorthand expands to both leaves off over the default, the
    // leaf written beside it still wins, and the raw value stays so admission
    // records its config_resolution.
    expect(shadow).toEqual({ logMismatches: "yes", mismatchLogging: { value: true, diff: "off" } });
    expect(resolveMismatchLogging(shadow)).toEqual({ value: true, diff: "off", invalid: true });
  });

  it.each([
    ["an omitted group", {}, { value: false, diff: "off", invalid: false }],
    ["an empty group", { mismatchLogging: {} }, { value: false, diff: "off", invalid: false }],
    [
      "undefined leaves",
      { mismatchLogging: { value: undefined, diff: undefined } },
      { value: false, diff: "off", invalid: false },
    ],
    ["valid leaves", { mismatchLogging: { value: true, diff: "paths" } }, { value: true, diff: "paths", invalid: false }],
    [
      "a non-boolean value leaf",
      { mismatchLogging: { value: "true", diff: "paths" } },
      { value: false, diff: "paths", invalid: true },
    ],
    ["a null value leaf", { mismatchLogging: { value: null } }, { value: false, diff: "off", invalid: true }],
    [
      "an unknown diff level",
      { mismatchLogging: { value: true, diff: "full" } },
      { value: true, diff: "off", invalid: true },
    ],
    ["a non-string diff leaf", { mismatchLogging: { diff: 1 } }, { value: false, diff: "off", invalid: true }],
    ["a malformed shorthand", { logMismatches: "yes" }, { value: false, diff: "off", invalid: true }],
    ["a null shorthand", { logMismatches: null }, { value: false, diff: "off", invalid: true }],
    [
      "a malformed shorthand beside both leaves",
      { logMismatches: "yes", mismatchLogging: { value: true, diff: "values" } },
      { value: true, diff: "values", invalid: true },
    ],
    ["an inherited shorthand", Object.create({ logMismatches: true }), { value: false, diff: "off", invalid: false }],
    [
      "an inherited group",
      Object.create({ mismatchLogging: { value: true, diff: "values" } }),
      { value: false, diff: "off", invalid: false },
    ],
    [
      "inherited leaves",
      { mismatchLogging: Object.create({ value: true, diff: "values" }) },
      { value: false, diff: "off", invalid: false },
    ],
    ["a null group", { mismatchLogging: null }, { value: false, diff: "off", invalid: true }],
    ["an array group", { mismatchLogging: [] }, { value: false, diff: "off", invalid: true }],
    ["a numeric group", { mismatchLogging: 1 }, { value: false, diff: "off", invalid: true }],
    ["a string group", { mismatchLogging: "paths" }, { value: false, diff: "off", invalid: true }],
    [
      "a non-object group beside a true shorthand",
      { logMismatches: true, mismatchLogging: null },
      { value: false, diff: "off", invalid: true },
    ],
  ])("resolves %s to the effective mismatch-logging leaves", (_name, shadow, expected) => {
    expect(resolveMismatchLogging(shadow)).toEqual(expected);
  });

  it("rejects the removed shadowRamp field without also reporting it as unknown", async () => {
    const onUnknownFields = vi.fn();

    await expect(fetchKeyConfig(
      async () => ({ ttlSec: {}, ramp: {}, shadowRamp: 100 }) as unknown as DialCacheKeyConfig,
      key(),
      onUnknownFields,
    )).rejects.toThrow('DialCacheKeyConfig.shadowRamp was replaced by "shadow.ramp"');
    expect(onUnknownFields).not.toHaveBeenCalled();
    expect(hasUnknownKeyConfigFields({ ttlSec: {}, ramp: {}, shadowRamp: 100 })).toBe(false);
  });

  it("ignores an inherited shadow group or ramp in a raw provider result", async () => {
    const defaultConfig = new DialCacheKeyConfig({ ttlSec: { [CacheLayer.REMOTE]: 60 } });
    const inheritedGroup = await fetchKeyConfig(
      async () => Object.assign(
        Object.create({ shadow: { ramp: 100, logMismatches: true } }) as DialCacheKeyConfig,
        { ttlSec: {}, ramp: {} },
      ),
      key(defaultConfig),
      ignoreUnknownFields,
    );
    const inheritedRamp = await fetchKeyConfig(
      async () => ({
        ttlSec: {},
        ramp: {},
        shadow: Object.assign(Object.create({ ramp: 100 }) as ShadowConfig, { logMismatches: true }),
      }) as unknown as DialCacheKeyConfig,
      key(defaultConfig),
      ignoreUnknownFields,
    );

    expect(inheritedGroup?.shadow).toBeUndefined();
    expect(inheritedRamp?.shadow).toEqual({ mismatchLogging: { value: true, diff: "values" } });
  });

  it("expands the logMismatches shorthand before the same group's leaves override it", () => {
    expect(expandMismatchLogging({})).toStrictEqual({});
    expect(expandMismatchLogging({ logMismatches: true })).toStrictEqual({ value: true, diff: "values" });
    expect(expandMismatchLogging({ logMismatches: false })).toStrictEqual({ value: false, diff: "off" });
    expect(expandMismatchLogging({ logMismatches: "yes" })).toStrictEqual({ value: false, diff: "off", invalid: true });
    expect(expandMismatchLogging({ logMismatches: true, mismatchLogging: { value: false } }))
      .toStrictEqual({ value: false, diff: "values" });
    expect(expandMismatchLogging({ logMismatches: "yes", mismatchLogging: { value: true, diff: "paths" } }))
      .toStrictEqual({ value: true, diff: "paths", invalid: true });
    // An undefined leaf is unwritten, and written leaves pass through
    // unvalidated: resolution owns their validation.
    expect(expandMismatchLogging({ logMismatches: true, mismatchLogging: { value: undefined } }))
      .toStrictEqual({ value: true, diff: "values" });
    expect(expandMismatchLogging({ mismatchLogging: { diff: "full" } })).toStrictEqual({ diff: "full" });
    expect(expandMismatchLogging(Object.create({ logMismatches: true, mismatchLogging: { value: true } })))
      .toStrictEqual({});
    expect(expandMismatchLogging({ mismatchLogging: Object.create({ diff: "values" }) })).toStrictEqual({});
    expect(expandMismatchLogging({ logMismatches: true, mismatchLogging: null }))
      .toStrictEqual({ value: false, diff: "off", invalid: true });
  });

  it.each([
    ["the top level", { ttlSec: { [CacheLayer.LOCAL]: 30 }, ttl: 60 }],
    ["ttlSec", { ttlSec: { [CacheLayer.LOCAL]: 30, edge: 60 } }],
    ["ramp", { ttlSec: { [CacheLayer.LOCAL]: 30 }, ramp: { [CacheLayer.LOCAL]: 100, edge: 50 } }],
    ["shadow", { ttlSec: { [CacheLayer.LOCAL]: 30 }, shadow: { ramp: 5, logMismatch: true } }],
    [
      "mismatchLogging",
      { ttlSec: { [CacheLayer.LOCAL]: 30 }, shadow: { mismatchLogging: { diff: "paths", values: true } } },
    ],
  ])("reports unknown provider fields at %s once and still merges the known fields", async (_name, input) => {
    // A constructed config remembers the unknown fields its input carried.
    for (const runtime of [input, new DialCacheKeyConfig(input as never)]) {
      const onUnknownFields = vi.fn();

      const merged = await fetchKeyConfig(async () => runtime as DialCacheKeyConfig, key(), onUnknownFields);

      expect(onUnknownFields).toHaveBeenCalledTimes(1);
      expect(merged?.ttlSec[CacheLayer.LOCAL]).toBe(30);
      expect(hasUnknownKeyConfigFields(merged)).toBe(false);
    }
  });

  it("does not report unknown fields for known-only or null provider results", async () => {
    const knownOnly = {
      ttlSec: { [CacheLayer.LOCAL]: 30, [CacheLayer.REMOTE]: 60 },
      ramp: { [CacheLayer.LOCAL]: 100, [CacheLayer.REMOTE]: 50 },
      shadow: { ramp: 5, logMismatches: true, mismatchLogging: { value: false, diff: "paths" } },
      requestLocal: true,
      coalesce: false,
      staleOnErrorMaxAgeSec: 0,
      remoteReadTimeoutMs: 50,
    } as const;
    // A default's unknown fields are reported when it is registered, not on
    // every resolution.
    const defaultWithUnknownFields = new DialCacheKeyConfig({ ...knownOnly, ttl: 60 } as never);
    const onUnknownFields = vi.fn();

    for (const runtime of [knownOnly, new DialCacheKeyConfig(knownOnly), DialCacheKeyConfig.disabled(), null, undefined]) {
      await fetchKeyConfig(
        async () => runtime as DialCacheKeyConfig | null,
        key(defaultWithUnknownFields),
        onUnknownFields,
      );
    }

    expect(onUnknownFields).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a number", 1],
    ["a string", "paths"],
  ])("rejects a provider result whose mismatchLogging is %s", async (_name, mismatchLogging) => {
    const onUnknownFields = vi.fn();
    const runtime = { ttlSec: {}, ramp: {}, shadow: { mismatchLogging } } as unknown as DialCacheKeyConfig;

    await expect(fetchKeyConfig(async () => runtime, key(), onUnknownFields)).rejects.toThrow(
      new TypeError("DialCache shadow mismatchLogging config must be an object"),
    );
    expect(onUnknownFields).not.toHaveBeenCalled();

    // Unknown fields are reported before the merge, so a result that then
    // fails resolution is still reported.
    await expect(fetchKeyConfig(
      async () => ({ ...runtime, ttl: 60 }) as DialCacheKeyConfig,
      key(),
      onUnknownFields,
    )).rejects.toThrow(TypeError);
    expect(onUnknownFields).toHaveBeenCalledTimes(1);
  });

  it("keeps invalid stale-on-error policy diagnostic-only in remote resolution", () => {
    const remoteKey = key();

    expect(resolveRemoteLayerConfigResult({
      config: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        staleOnErrorMaxAgeSec: 3_600,
      }),
      key: remoteKey,
    })).toEqual({
      status: "enabled",
      config: { ttlSec: 60, ramp: 100, staleOnErrorMaxAgeSec: 3_600 },
    });
    expect(resolveRemoteLayerConfigResult({
      config: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        staleOnErrorMaxAgeSec: 60,
      }),
      key: remoteKey,
    })).toEqual({
      status: "enabled",
      config: { ttlSec: 60, ramp: 100, staleOnErrorMaxAgeSec: null },
      staleOnErrorConfigError: true,
    });
    expect(resolveRemoteLayerConfigResult({
      config: new DialCacheKeyConfig({
        ttlSec: { [CacheLayer.REMOTE]: 60 },
        staleOnErrorMaxAgeSec: 0,
      }),
      key: remoteKey,
    })).toEqual({
      status: "enabled",
      config: { ttlSec: 60, ramp: 100, staleOnErrorMaxAgeSec: null },
    });
    expect(resolveRemoteLayerConfigResult({
      config: new DialCacheKeyConfig({ staleOnErrorMaxAgeSec: 3_600 }),
      key: remoteKey,
    })).toEqual({
      status: "disabled",
      reason: "policy_disabled",
      staleOnErrorConfigError: true,
    });
  });
});
