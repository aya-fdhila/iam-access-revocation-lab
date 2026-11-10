import { buildApp } from "./app.js";
import { CachedAuthenticator, IntrospectionAuthenticator, LocalJwtAuthenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { ApiMetrics } from "./metrics.js";
import { type NotBeforeStore, RedisNotBeforeStore } from "./not-before.js";

const config = loadConfig();
const metrics = new ApiMetrics(config.validationMode);
let notBeforeStore: NotBeforeStore | undefined;

if (config.validationMode === "local") {
  if (config.notBeforeRedisPassword === null) {
    throw new Error("NOT_BEFORE_REDIS_PASSWORD is required for local validation.");
  }
  const redisStore = new RedisNotBeforeStore({
    url: config.notBeforeRedisUrl,
    password: config.notBeforeRedisPassword,
  });
  await redisStore.connect();
  notBeforeStore = redisStore;
}

const introspectionAuthenticator =
  config.validationMode === "local"
    ? undefined
    : new IntrospectionAuthenticator({ config, metrics });
const authenticator =
  config.validationMode === "local"
    ? new LocalJwtAuthenticator({
        config,
        metrics,
        notBeforeStore: notBeforeStore as NotBeforeStore,
      })
    : config.validationMode === "cached-introspection"
      ? new CachedAuthenticator({
          delegate: introspectionAuthenticator as IntrospectionAuthenticator,
          maxEntries: config.introspectionCacheMaxEntries,
          metrics,
          ttlSeconds: config.introspectionCacheTtlSeconds,
        })
      : (introspectionAuthenticator as IntrospectionAuthenticator);

const app = await buildApp({
  config,
  authenticator,
  metrics,
  ...(notBeforeStore ? { notBeforeStore } : {}),
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await app.close();
    await notBeforeStore?.close();
    process.exit(0);
  });
}

await app.listen({ host: config.host, port: config.port });
