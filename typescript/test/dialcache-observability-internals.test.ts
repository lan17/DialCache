import { describe, expect, it } from "vitest";

import { CacheLayer, DialCacheKey, DialCacheKeyConfig, type ShadowConfig } from "../src/index.js";
import {
  expandMismatchLogging,
  fetchKeyConfig,
  resolveMismatchLogging,
  resolveRemoteLayerConfigResult,
} from "../src/internal/runtime-config.js";

const key = (defaultConfig: DialCacheKeyConfig | null = DialCacheKeyConfig.enabled(60)) =>
  new DialCacheKey({ keyType: "user_id", id: "123", useCase: "ObservabilityInternals", defaultConfig });

/** The shadow group fetchKeyConfig merges from one default and one runtime shadow group. */
async function mergedShadow(
  defaultShadow: ShadowConfig | undefined,
  runtimeShadow: ShadowConfig,
): Promise<ShadowConfig> {
  const merged = await fetchKeyConfig(
    async () => new DialCacheKeyConfig({ shadow: runtimeShadow }),
    key(new DialCacheKeyConfig(defaultShadow === undefined ? {} : { shadow: defaultShadow })),
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
          shadow: { ramp: 80, mismatchLogging: { value: true, diff: "values" } },
          staleOnErrorMaxAgeSec: 3_600,
        }),
        effective: { value: true, diff: "values" },
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
          shadow: { ramp: 20, mismatchLogging: { value: false, diff: "off" } },
          staleOnErrorMaxAgeSec: 0,
        }),
        effective: { value: false, diff: "off" },
      },
      {
        runtime: new DialCacheKeyConfig({ shadow: {}, staleOnErrorMaxAgeSec: 7_200 }),
        expected: new DialCacheKeyConfig({
          requestLocal: true,
          coalesce: false,
          ttlSec: { [CacheLayer.LOCAL]: 60, [CacheLayer.REMOTE]: 120 },
          ramp: { [CacheLayer.LOCAL]: 25, [CacheLayer.REMOTE]: 50 },
          shadow: { ramp: 20, mismatchLogging: { value: true, diff: "values" } },
          staleOnErrorMaxAgeSec: 7_200,
        }),
        effective: { value: true, diff: "values" },
      },
    ];

    for (const { runtime, expected, effective } of cases) {
      const merged = await fetchKeyConfig(async () => runtime, key(defaultConfig));

      expect(merged).toEqual(expected);
      // Each layer's shorthand expands before the merge, so only leaves remain.
      expect(merged?.shadow).not.toHaveProperty("logMismatches");
      expect(resolveMismatchLogging(merged!.shadow!)).toEqual({ ...effective, invalid: false });
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

    const merged = await fetchKeyConfig(async () => runtime, key(defaultConfig));

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
    const overShorthand = await mergedShadow({ logMismatches: true }, { mismatchLogging: { diff: "paths" } });
    expect(overShorthand).toEqual({ mismatchLogging: { value: true, diff: "paths" } });
    expect(resolveMismatchLogging(overShorthand)).toEqual({ value: true, diff: "paths", invalid: false });
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
    [
      "a diff leaf naming an Object.prototype member",
      { mismatchLogging: { diff: "toString" } },
      { value: false, diff: "off", invalid: true },
    ],
    [
      "a diff leaf naming the constructor",
      { mismatchLogging: { value: true, diff: "constructor" } },
      { value: true, diff: "off", invalid: true },
    ],
    ["a malformed shorthand", { logMismatches: "yes" }, { value: false, diff: "off", invalid: true }],
    ["a null shorthand", { logMismatches: null }, { value: false, diff: "off", invalid: true }],
    [
      "a malformed shorthand beside both leaves",
      { logMismatches: "yes", mismatchLogging: { value: true, diff: "values" } },
      { value: true, diff: "values", invalid: true },
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

  it("rejects the removed shadowRamp field in a provider result", async () => {
    await expect(fetchKeyConfig(
      async () => ({ ttlSec: {}, ramp: {}, shadowRamp: 100 }) as unknown as DialCacheKeyConfig,
      key(),
    )).rejects.toThrow('DialCacheKeyConfig.shadowRamp was replaced by "shadow.ramp"');
  });

  it("resolves every merged combination of shorthand and leaves as each layer expanded first", async () => {
    // The recorded rule, written out independently of the merge: expand each
    // layer, merge leaf by leaf, and let an invalid runtime shorthand still owe
    // one config_resolution. Defaults stay valid, as registration guarantees.
    const expectedLeaves = (defaultShadow: object | undefined, runtimeShadow: object | undefined) => {
      const inherited = defaultShadow === undefined ? {} : expandMismatchLogging(defaultShadow);
      const written = runtimeShadow === undefined ? {} : expandMismatchLogging(runtimeShadow);
      return resolveMismatchLogging({
        ...(written.invalid === true ? { logMismatches: "invalid" } : {}),
        mismatchLogging: {
          value: written.value !== undefined ? written.value : inherited.value,
          diff: written.diff !== undefined ? written.diff : inherited.diff,
        },
      });
    };
    const ABSENT = Symbol("absent");
    const OWN_UNDEFINED = Symbol("own undefined");
    // Builds one shadow group, with each field absent, written as undefined,
    // or written with the given value.
    const layer = (shorthand: unknown, group: unknown): Record<string, unknown> => {
      const shadow: Record<string, unknown> = {};
      for (const [name, field] of [["logMismatches", shorthand], ["mismatchLogging", group]] as const) {
        if (field !== ABSENT) {
          shadow[name] = field === OWN_UNDEFINED ? undefined : field;
        }
      }
      return shadow;
    };
    const defaultShorthands: unknown[] = [ABSENT, OWN_UNDEFINED, true, false];
    const defaultGroups: unknown[] = [
      ABSENT,
      OWN_UNDEFINED,
      {},
      { value: true },
      { value: false },
      { diff: "paths" },
      { diff: "off" },
      { value: true, diff: "values" },
      { value: undefined, diff: "paths" },
    ];
    const runtimeShorthands: unknown[] = [ABSENT, OWN_UNDEFINED, true, false, "yes", null, 0];
    const runtimeGroups: unknown[] = [
      ABSENT,
      OWN_UNDEFINED,
      { value: true },
      { value: false },
      { diff: "paths" },
      { diff: "values" },
      { value: true, diff: "off" },
      { value: "yes" },
      { value: null },
      { diff: "full" },
      { diff: "toString" },
      { value: undefined },
    ];

    let combinations = 0;
    for (const defaultShorthand of defaultShorthands) {
      for (const defaultGroup of defaultGroups) {
        const defaultShadow = layer(defaultShorthand, defaultGroup);
        const defaultConfig = new DialCacheKeyConfig({ shadow: defaultShadow as ShadowConfig });
        for (const runtimeShorthand of runtimeShorthands) {
          for (const runtimeGroup of runtimeGroups) {
            const runtimeShadow = layer(runtimeShorthand, runtimeGroup);
            const expected = expectedLeaves(defaultShadow, runtimeShadow);
            // A constructed runtime config clones the group; a raw provider
            // result reaches the merge as written.
            for (const runtime of [
              new DialCacheKeyConfig({ shadow: runtimeShadow as ShadowConfig }),
              { ttlSec: {}, ramp: {}, shadow: runtimeShadow } as unknown as DialCacheKeyConfig,
            ]) {
              const merged = await fetchKeyConfig(async () => runtime, key(defaultConfig));
              expect(resolveMismatchLogging(merged!.shadow!)).toEqual(expected);
              combinations += 1;
            }
          }
        }
      }
    }
    expect(combinations).toBe(4 * 9 * 7 * 12 * 2);

    // disabled() on either side, and a runtime config without a shadow group.
    const disabledShadow = DialCacheKeyConfig.disabled().shadow!;
    for (const [defaultShadow, runtime] of [
      [{ logMismatches: true }, DialCacheKeyConfig.disabled()],
      [disabledShadow, new DialCacheKeyConfig({ shadow: { mismatchLogging: { diff: "paths" } } })],
      [{ logMismatches: true, mismatchLogging: { diff: "paths" } }, new DialCacheKeyConfig({ ttlSec: {} })],
    ] as const) {
      const merged = await fetchKeyConfig(
        async () => runtime,
        key(new DialCacheKeyConfig({ shadow: defaultShadow })),
      );
      expect(resolveMismatchLogging(merged!.shadow!)).toEqual(expectedLeaves(defaultShadow, runtime.shadow));
    }
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
    expect(expandMismatchLogging({ logMismatches: true, mismatchLogging: null }))
      .toStrictEqual({ value: false, diff: "off", invalid: true });
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a number", 1],
    ["a string", "paths"],
  ])("rejects a provider result whose mismatchLogging is %s", async (_name, mismatchLogging) => {
    const runtime = { ttlSec: {}, ramp: {}, shadow: { mismatchLogging } } as unknown as DialCacheKeyConfig;

    await expect(fetchKeyConfig(async () => runtime, key())).rejects.toThrow(
      new TypeError("DialCache shadow mismatchLogging config must be an object"),
    );
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
