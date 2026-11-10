import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ValidationMode } from "../src/config.js";
import { MemoryNotBeforeStore } from "../src/not-before.js";
import { principal, TokenMapAuthenticator, testConfig } from "./helpers.js";

const tokens = new Map([
  ["ali", principal()],
  [
    "manager",
    principal({
      subject: "subject-marwen",
      username: "marwen",
      roles: new Set(["employees", "managers"]),
    }),
  ],
  [
    "admin",
    principal({
      subject: "subject-aya",
      username: "aya",
      roles: new Set(["admins"]),
      scopes: new Set(["docs:read", "docs:write", "admin"]),
    }),
  ],
  [
    "job",
    principal({
      subject: "service-account-subject",
      username: "service-account-job",
      clientId: "job",
      roles: new Set(),
      scopes: new Set(["reports:run"]),
    }),
  ],
  ["no-scope", principal({ scopes: new Set() })],
  ["no-role", principal({ roles: new Set() })],
]);

describe.each(["local", "introspection", "cached-introspection"] satisfies ValidationMode[])(
  "%s route policy",
  (mode) => {
    it("keeps authentication, scope, role, ownership, admin, and job decisions identical", async () => {
      const app = await buildApp({
        config: testConfig(mode),
        authenticator: new TokenMapAuthenticator(tokens),
        ...(mode === "local" ? { notBeforeStore: new MemoryNotBeforeStore() } : {}),
      });

      expect((await app.inject({ method: "GET", url: "/documents/2" })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/documents/2",
            headers: { authorization: "Bearer ali" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/documents/3",
            headers: { authorization: "Bearer ali" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/documents/3",
            headers: { authorization: "Bearer manager" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/documents/2",
            headers: { authorization: "Bearer no-scope" },
          })
        ).json().error.code,
      ).toBe("missing_scope");
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/documents/2",
            headers: { authorization: "Bearer no-role" },
          })
        ).json().error.code,
      ).toBe("missing_role");
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/admin/users",
            headers: { authorization: "Bearer ali" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/admin/users",
            headers: { authorization: "Bearer admin" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/reports/run",
            headers: { authorization: "Bearer ali" },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/reports/run",
            headers: { authorization: "Bearer job" },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/documents",
            headers: { authorization: "Bearer job" },
          })
        ).statusCode,
      ).toBe(403);

      const created = await app.inject({
        method: "POST",
        url: "/documents",
        headers: { authorization: "Bearer ali" },
        payload: { title: "Ali-owned document" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ owner: "ali" });
      await app.close();
    });
  },
);

describe("browser origin boundary", () => {
  it("allows only the configured web application origin", async () => {
    const app = await buildApp({
      config: testConfig("local"),
      authenticator: new TokenMapAuthenticator(tokens),
      notBeforeStore: new MemoryNotBeforeStore(),
    });
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/me",
      headers: {
        origin: "https://app.localhost",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    const refused = await app.inject({
      method: "OPTIONS",
      url: "/me",
      headers: {
        origin: "https://attacker.invalid",
        "access-control-request-method": "GET",
      },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.localhost");
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });
});

describe("internal not-before endpoint", () => {
  it("is local-mode only, secret protected, and monotonic", async () => {
    const store = new MemoryNotBeforeStore();
    const app = await buildApp({
      config: testConfig("local"),
      authenticator: new TokenMapAuthenticator(tokens),
      notBeforeStore: store,
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/internal/not-before/ali",
          payload: { timestamp: 100 },
        })
      ).statusCode,
    ).toBe(401);
    const first = await app.inject({
      method: "PUT",
      url: "/internal/not-before/ali",
      headers: { "x-offboarding-secret": testConfig().offboardingApiSecret },
      payload: { timestamp: 100 },
    });
    const second = await app.inject({
      method: "PUT",
      url: "/internal/not-before/ali",
      headers: { "x-offboarding-secret": testConfig().offboardingApiSecret },
      payload: { timestamp: 90 },
    });
    expect(first.json()).toMatchObject({ notBefore: 100 });
    expect(second.json()).toMatchObject({ notBefore: 100 });
    await app.close();
  });
});

describe("internal benchmark metrics endpoint", () => {
  it("requires the benchmark secret and resets counters", async () => {
    const config = testConfig("introspection");
    const app = await buildApp({
      config,
      authenticator: new TokenMapAuthenticator(tokens),
    });
    expect((await app.inject({ method: "POST", url: "/internal/metrics/reset" })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/internal/metrics/reset",
          headers: { "x-benchmark-secret": config.benchmarkApiSecret },
        })
      ).statusCode,
    ).toBe(204);
    await app.close();
  });
});
