import { createServer } from "node:http";

import { loadConfig } from "./config.js";
import { ScheduledReporter } from "./job.js";
import { ClientCredentialsTokenCache } from "./token-cache.js";

const config = loadConfig();
const reporter = new ScheduledReporter(config, new ClientCredentialsTokenCache(config));
let lastSuccessAt: string | null = null;
let lastAttemptSucceeded = false;
let running = false;

const run = async () => {
  if (running) return;
  running = true;
  try {
    await reporter.runOnce();
    lastSuccessAt = new Date().toISOString();
    lastAttemptSucceeded = true;
  } catch {
    lastAttemptSucceeded = false;
  } finally {
    running = false;
  }
};

const health = createServer((_request, response) => {
  response.statusCode = lastAttemptSucceeded ? 200 : 503;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({ status: lastAttemptSucceeded ? "ok" : "unavailable", lastSuccessAt }),
  );
});
health.listen(config.port, "0.0.0.0");
await run();
const interval = setInterval(() => void run(), config.intervalMs);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(interval);
    health.close(() => process.exit(0));
  });
}
