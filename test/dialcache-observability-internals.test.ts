import { describe, expect, it } from "vitest";

import { CacheLayer, DialCacheKey, DialCacheKeyConfig } from "../src/index.js";
import {
  fetchKeyConfig,
  resolveRemoteLayerConfigResult,
} from "../src/internal/runtime-config.js";

const key = (defaultConfig: DialCacheKeyConfig | null = DialCacheKeyConfig.enabled(60)) =>
  new DialCacheKey({ keyType: "user_id", id: "123", useCase: "ObservabilityInternals", defaultConfig });

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
            logMismatches: true,
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
            logMismatches: false,
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
            logMismatches: true,
          },
          staleOnErrorMaxAgeSec: 7_200,
        }),
      },
    ];

    for (const { runtime, expected } of cases) {
      await expect(fetchKeyConfig(async () => runtime, key(defaultConfig))).resolves.toEqual(expected);
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
