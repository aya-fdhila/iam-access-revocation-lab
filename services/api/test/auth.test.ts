import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  type Authenticator,
  CachedAuthenticator,
  IntrospectionAuthenticator,
  LocalJwtAuthenticator,
} from "../src/auth.js";
import { ApiError } from "../src/errors.js";
import { ApiMetrics } from "../src/metrics.js";
import { MemoryNotBeforeStore } from "../src/not-before.js";
import { principal, testConfig } from "./helpers.js";

async function signedToken(options: {
  privateKey: CryptoKey;
  audience?: string;
  expiresAt?: number;
  issuedAt?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    preferred_username: "ali",
    scope: "docs:read docs:write",
    realm_access: { roles: ["employees"] },
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://auth.localhost/realms/company")
    .setAudience(options.audience ?? "api")
    .setSubject("subject-ali")
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 60)
    .sign(options.privateKey);
}

describe("local JWT authentication", () => {
  it("accepts an exact issuer/audience token and enforces not-before", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const store = new MemoryNotBeforeStore();
    const issuedAt = Math.floor(Date.now() / 1000) - 1;
    const token = await signedToken({ privateKey, issuedAt });
    const authenticator = new LocalJwtAuthenticator({
      config: testConfig(),
      key: publicKey,
      metrics: new ApiMetrics("local"),
      notBeforeStore: store,
    });

    await expect(authenticator.authenticate(token)).resolves.toMatchObject({ username: "ali" });
    await store.setMonotonic({ username: "ali", timestamp: issuedAt + 1 });
    await expect(authenticator.authenticate(token)).rejects.toMatchObject({
      statusCode: 401,
      errorCode: "invalid_token",
    });
  });

  it.each([
    ["wrong audience", { audience: "another-api" }],
    ["expired", { expiresAt: Math.floor(Date.now() / 1000) - 10 }],
  ])("rejects a %s token", async (_label, tokenOptions) => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await signedToken({ privateKey, ...tokenOptions });
    const authenticator = new LocalJwtAuthenticator({
      config: testConfig(),
      key: publicKey,
      metrics: new ApiMetrics("local"),
      notBeforeStore: new MemoryNotBeforeStore(),
    });

    await expect(authenticator.authenticate(token)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a tampered signature and fails closed when an unknown key cannot refresh", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await signedToken({ privateKey });
    const segments = token.split(".");
    const signature = segments[2] as string;
    segments[2] = `${signature.startsWith("a") ? "b" : "a"}${signature.slice(1)}`;
    const tampered = segments.join(".");
    const base = {
      config: testConfig(),
      metrics: new ApiMetrics("local"),
      notBeforeStore: new MemoryNotBeforeStore(),
    };

    await expect(
      new LocalJwtAuthenticator({ ...base, key: publicKey }).authenticate(tampered),
    ).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(
      new LocalJwtAuthenticator({
        ...base,
        key: async () => Promise.reject(new Error("jwks unavailable")),
      }).authenticate(token),
    ).rejects.toMatchObject({ statusCode: 503 });
  });

  it("records bounded JWKS refresh outcomes", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await signedToken({ privateKey });
    const jwk = await exportJWK(publicKey);
    const metrics = new ApiMetrics("local");
    const jwksFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ keys: [{ ...jwk, alg: "RS256", kid: "test-key" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const authenticator = new LocalJwtAuthenticator({
      config: testConfig(),
      jwksFetchImplementation: jwksFetch,
      metrics,
      notBeforeStore: new MemoryNotBeforeStore(),
    });

    await expect(authenticator.authenticate(token)).resolves.toMatchObject({ username: "ali" });
    expect(jwksFetch).toHaveBeenCalledTimes(1);
    expect(await metrics.registry.metrics()).toContain(
      'iam_api_jwks_refreshes_total{outcome="success",mode="local"} 1',
    );
  });
});

describe("introspection authentication", () => {
  it("accepts active exact claims and rejects inactive tokens", async () => {
    const active = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          active: true,
          sub: "subject-ali",
          iss: testConfig().issuer,
          aud: "api",
          iat: 1_800_000_000,
          exp: 1_900_000_000,
          preferred_username: "ali",
          client_id: "test-cli",
          scope: "docs:read docs:write",
          realm_access: { roles: ["employees"] },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const authenticator = new IntrospectionAuthenticator({
      config: testConfig("introspection"),
      fetchImplementation: active,
      metrics: new ApiMetrics("introspection"),
    });
    await expect(authenticator.authenticate("active-token")).resolves.toMatchObject({
      username: "ali",
    });

    active.mockResolvedValueOnce(new Response(JSON.stringify({ active: false }), { status: 200 }));
    await expect(authenticator.authenticate("inactive-token")).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("fails closed with 503 when Keycloak is unavailable", async () => {
    const authenticator = new IntrospectionAuthenticator({
      config: testConfig("introspection"),
      fetchImplementation: vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")),
      metrics: new ApiMetrics("introspection"),
    });
    await expect(authenticator.authenticate("token")).rejects.toMatchObject({ statusCode: 503 });
  });

  it("treats a malformed success response as a dependency failure", async () => {
    const authenticator = new IntrospectionAuthenticator({
      config: testConfig("introspection"),
      fetchImplementation: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("not-json", { status: 200 })),
      metrics: new ApiMetrics("introspection"),
    });
    await expect(authenticator.authenticate("token")).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("positive introspection cache", () => {
  it("uses a hashed bounded positive cache and never serves beyond token expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
    let calls = 0;
    const delegate: Authenticator = {
      async authenticate() {
        calls += 1;
        return principal({ expiresAt: Math.floor(Date.now() / 1000) + 2 });
      },
    };
    const cached = new CachedAuthenticator({
      delegate,
      maxEntries: 1,
      metrics: new ApiMetrics("cached-introspection"),
      ttlSeconds: 5,
    });

    await cached.authenticate("secret-token");
    await cached.authenticate("secret-token");
    expect(calls).toBe(1);
    vi.advanceTimersByTime(2100);
    await cached.authenticate("secret-token");
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it("does not cache refusal results", async () => {
    let calls = 0;
    const delegate: Authenticator = {
      async authenticate() {
        calls += 1;
        throw new ApiError({ statusCode: 401, errorCode: "invalid_token", message: "invalid" });
      },
    };
    const cached = new CachedAuthenticator({
      delegate,
      maxEntries: 2,
      metrics: new ApiMetrics("cached-introspection"),
      ttlSeconds: 5,
    });
    await expect(cached.authenticate("bad")).rejects.toBeInstanceOf(ApiError);
    await expect(cached.authenticate("bad")).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(2);
  });
});
