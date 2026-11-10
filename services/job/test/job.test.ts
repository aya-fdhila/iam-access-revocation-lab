import { describe, expect, it, vi } from "vitest";

import type { JobConfig } from "../src/config.js";
import { ScheduledReporter } from "../src/job.js";
import { ClientCredentialsTokenCache } from "../src/token-cache.js";

const config: JobConfig = {
  tokenUrl: "http://identity.test/token",
  clientId: "job",
  clientSecret: "client-secret-never-log",
  reportsUrl: "http://api.test/reports/run",
  intervalMs: 60_000,
  renewBeforeMs: 10_000,
  port: 3001,
};

describe("ClientCredentialsTokenCache", () => {
  it("reuses a token then renews shortly before expiry", async () => {
    let now = 1_000;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token-one", expires_in: 30 }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "token-two", expires_in: 30 }), {
          status: 200,
        }),
      );
    const cache = new ClientCredentialsTokenCache(config, request, () => now);

    expect(await cache.get()).toEqual({ accessToken: "token-one", reused: false });
    now = 10_000;
    expect(await cache.get()).toEqual({ accessToken: "token-one", reused: true });
    now = 21_000;
    expect(await cache.get()).toEqual({ accessToken: "token-two", reused: false });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("sends the client secret only in the token request body", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "machine-token", expires_in: 60 }), {
        status: 200,
      }),
    );
    await new ClientCredentialsTokenCache(config, request).get();
    const [url, init] = request.mock.calls[0] ?? [];
    expect(url).toBe(config.tokenUrl);
    expect(String(init?.body)).toContain("client_secret=client-secret-never-log");
    expect(JSON.stringify(init?.headers)).not.toContain(config.clientSecret);
  });
});

describe("ScheduledReporter", () => {
  it("logs successful calls without logging tokens or secrets", async () => {
    const logs: Array<Record<string, boolean | number | string>> = [];
    const tokens = {
      get: vi.fn().mockResolvedValue({ accessToken: "machine-token-never-log", reused: true }),
    } as unknown as ClientCredentialsTokenCache;
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    const reporter = new ScheduledReporter(config, tokens, request, (record) => logs.push(record));

    await reporter.runOnce();

    expect(request).toHaveBeenCalledWith(
      config.reportsUrl,
      expect.objectContaining({ headers: { authorization: "Bearer machine-token-never-log" } }),
    );
    expect(logs).toEqual([
      expect.objectContaining({
        event: "scheduled_report.completed",
        status: 200,
        tokenReused: true,
      }),
    ]);
    const output = JSON.stringify(logs);
    expect(output).not.toContain("machine-token-never-log");
    expect(output).not.toContain(config.clientSecret);
  });

  it("records a safe failure and rejects the run", async () => {
    const logs: Array<Record<string, boolean | number | string>> = [];
    const tokens = {
      get: vi.fn().mockResolvedValue({ accessToken: "machine-token-never-log", reused: false }),
    } as unknown as ClientCredentialsTokenCache;
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 403 }));
    const reporter = new ScheduledReporter(config, tokens, request, (record) => logs.push(record));

    await expect(reporter.runOnce()).rejects.toThrow("Reports endpoint returned 403");
    expect(logs[0]).toEqual(expect.objectContaining({ event: "scheduled_report.failed" }));
    expect(JSON.stringify(logs)).not.toContain("machine-token-never-log");
  });
});
