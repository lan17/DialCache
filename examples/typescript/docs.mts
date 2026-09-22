// Executable source for the shared guides. The package test compiles this file
// against the packed npm package and runs it; regions are imported by VitePress.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { DialCache, DialCacheKeyConfig } from "dialcache";
import { createNodeRedisDialCacheClient } from "dialcache/node-redis";

async function requestScope(): Promise<void> {
  // #region request-scope
  const cache = new DialCache();
  let sourceCalls = 0;
  const lookup = cache.cached(async (_id: string) => ++sourceCalls, {
    keyType: "user",
    useCase: "requestScope",
    cacheKey: (id) => id,
    // Only request-local storage is enabled: shared layers stay off.
    defaultConfig: new DialCacheKeyConfig({ requestLocal: true }),
  });

  // Outside an enabled scope, each call reaches the source.
  assert.equal(await lookup("42"), 1);
  assert.equal(await lookup("42"), 2);

  await cache.enable(async () => {
    assert.equal(await lookup("42"), 3);
    assert.equal(await lookup("42"), 3);
  });
  // A new request starts with an empty request-local cache.
  await cache.enable(async () => {
    assert.equal(await lookup("42"), 4);
  });
  assert.equal(sourceCalls, 4);
  // #endregion request-scope
}

async function runtimePolicy(): Promise<void> {
  // #region runtime-policy
  // In an application, this value can come from your runtime config service.
  let overlay = new DialCacheKeyConfig({ coalesce: false });
  const cache = new DialCache({ cacheConfigProvider: () => overlay });
  let sourceCalls = 0;
  const lookup = cache.cached(async (_id: string) => ++sourceCalls, {
    keyType: "user",
    useCase: "runtimePolicy",
    cacheKey: (id) => id,
    defaultConfig: new DialCacheKeyConfig({
      requestLocal: true,
      ttlSec: { local: 60 },
      ramp: { local: 100 },
    }),
  });

  // The sparse overlay inherits the local TTL: separate requests reuse it.
  assert.equal(await cache.enable(() => lookup("42")), 1);
  assert.equal(await cache.enable(() => lookup("42")), 1);

  // Explicit false and zero disable the two configured cache paths.
  overlay = new DialCacheKeyConfig({
    requestLocal: false,
    ramp: { local: 0 },
  });
  await cache.enable(async () => {
    assert.equal(await lookup("42"), 2);
    assert.equal(await lookup("42"), 3);
  });
  assert.equal(sourceCalls, 3);
  // #endregion runtime-policy
}

async function trackedInvalidation(url: string): Promise<void> {
  const namespace = `docs-ts-${randomUUID()}`;
  const client = createClient({
    url,
    socket: { connectTimeout: 2_000, reconnectStrategy: false },
    disableOfflineQueue: true,
  });
  client.on("error", (error) => console.error("Redis example client:", error));
  await client.connect();
  try {
    // #region tracked-invalidation
    // client is a connected, caller-owned node-redis client.
    const cache = new DialCache({
      namespace,
      redis: { client: createNodeRedisDialCacheClient(client), readTimeoutMs: 1_000 },
    });
    let sourceVersion = 1;
    let sourceCalls = 0;
    const profileVersion = cache.cached(async (_id: string) => {
      sourceCalls++;
      return sourceVersion;
    }, {
      keyType: "user",
      useCase: "profileVersion",
      cacheKey: (id) => id,
      trackForInvalidation: true,
      // Keep local layers off so every request observes the Redis watermark.
      defaultConfig: new DialCacheKeyConfig({
        ttlSec: { remote: 60 },
        ramp: { remote: 100 },
      }),
    });

    assert.equal(await cache.enable(() => profileVersion("42")), 1);
    sourceVersion = 2; // Represents a successfully committed source update.
    assert.equal(await cache.enable(() => profileVersion("42")), 1);
    assert.equal(sourceCalls, 1); // The previous value really was cached.

    await cache.invalidateRemote("user", "42");
    assert.equal(await cache.enable(() => profileVersion("42")), 2);
    assert.equal(sourceCalls, 2);
    // #endregion tracked-invalidation
  } finally {
    // Remove only this example's unique keys, never unrelated Redis data.
    const prefix = `{${namespace}:user:42}`;
    try {
      await client.del([`${prefix}#profileVersion:dialcache-frame-v1`, `${prefix}#watermark`]);
    } finally {
      await client.disconnect();
    }
  }
}

await requestScope();
await runtimePolicy();
if (process.env.DOCS_REDIS_URL) {
  await trackedInvalidation(process.env.DOCS_REDIS_URL);
} else {
  console.log("SKIP tracked-invalidation: set DOCS_REDIS_URL to execute the Redis example");
}
console.log("dialcache-docs-examples-passed");
