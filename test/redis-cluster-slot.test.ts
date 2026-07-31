import { describe, expect, it } from "vitest";

import {
  groupByRedisClusterSlot,
  redisClusterSlot,
} from "../src/internal/redis-cluster-slot.js";

describe("Redis Cluster slot calculation", () => {
  it.each([
    ["", 0],
    ["123456789", 12_739],
    ["somekey", 11_058],
    ["foo{bar}", 5_061],
    ["{user1000}.following", 3_443],
    ["{user1000}.followers", 3_443],
  ])("maps %j to slot %i", (key, expectedSlot) => {
    expect(redisClusterSlot(key)).toBe(expectedSlot);
  });

  it("uses the first valid hash tag and hashes the whole key when the first braces are empty", () => {
    expect(redisClusterSlot("foo{bar}{zap}"))
      .toBe(redisClusterSlot("bar"));
    expect(redisClusterSlot("foo{}{bar}"))
      .toBe(8_363);
    expect(redisClusterSlot("foo{}{bar}"))
      .not.toBe(redisClusterSlot("bar"));
    expect(redisClusterSlot("foo{{bar}}zap"))
      .toBe(redisClusterSlot("{bar"));
  });

  it.each([
    ["mañana", 8_542],
    ["{東京}:key", 16_157],
  ])("hashes the UTF-8 bytes of %j", (key, expectedSlot) => {
    expect(redisClusterSlot(key)).toBe(expectedSlot);
  });

  it("groups different hash tags that collide on the same exact slot", () => {
    const requests = [
      { watermarkKey: "prefix:{k-620}:watermark", id: "first" },
      { watermarkKey: "prefix:{different}:watermark", id: "other" },
      { watermarkKey: "prefix:{k-1000}:watermark", id: "second" },
    ];

    expect(redisClusterSlot(requests[0]!.watermarkKey)).toBe(6_474);
    expect(redisClusterSlot(requests[2]!.watermarkKey)).toBe(6_474);

    const groups = groupByRedisClusterSlot(requests, ({ watermarkKey }) => watermarkKey);

    expect(groups.get(6_474)).toEqual([requests[0], requests[2]]);
    expect([...groups.values()].flat()).toHaveLength(requests.length);
    expect(groups.size).toBe(2);
  });
});
