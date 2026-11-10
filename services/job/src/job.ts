import { performance } from "node:perf_hooks";

import type { JobConfig } from "./config.js";
import type { ClientCredentialsTokenCache } from "./token-cache.js";

export type SafeLog = (record: Record<string, boolean | number | string>) => void;

export class ScheduledReporter {
  constructor(
    private readonly config: JobConfig,
    private readonly tokens: ClientCredentialsTokenCache,
    private readonly request: typeof fetch = fetch,
    private readonly log: SafeLog = (record) => console.log(JSON.stringify(record)),
  ) {}

  async runOnce(): Promise<void> {
    const started = performance.now();
    try {
      const lease = await this.tokens.get();
      const response = await this.request(this.config.reportsUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${lease.accessToken}` },
      });
      if (!response.ok) throw new Error(`Reports endpoint returned ${response.status}.`);
      this.log({
        event: "scheduled_report.completed",
        status: response.status,
        durationMs: Math.round(performance.now() - started),
        tokenReused: lease.reused,
      });
    } catch (caught) {
      this.log({
        event: "scheduled_report.failed",
        durationMs: Math.round(performance.now() - started),
        error: caught instanceof Error ? caught.message : "Unknown error",
      });
      throw caught;
    }
  }
}
