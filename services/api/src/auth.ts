import { createHash } from "node:crypto";

import {
  createRemoteJWKSet,
  customFetch,
  type JWTVerifyGetKey,
  errors as joseErrors,
  jwtVerify,
} from "jose";

import type { ApiConfig } from "./config.js";
import { ApiError, dependencyUnavailable, unauthenticated } from "./errors.js";
import type { ApiMetrics } from "./metrics.js";
import type { NotBeforeStore } from "./not-before.js";
import { type Principal, principalFromClaims } from "./principal.js";

export interface Authenticator {
  authenticate(token: string): Promise<Principal>;
}

type LocalAuthenticatorOptions = {
  config: ApiConfig;
  notBeforeStore: NotBeforeStore;
  metrics: ApiMetrics;
  key?: JWTVerifyGetKey | CryptoKey | Uint8Array;
  jwksFetchImplementation?: typeof fetch;
};

export class LocalJwtAuthenticator implements Authenticator {
  readonly #config: ApiConfig;
  readonly #notBeforeStore: NotBeforeStore;
  readonly #metrics: ApiMetrics;
  readonly #key: JWTVerifyGetKey | CryptoKey | Uint8Array;

  constructor(options: LocalAuthenticatorOptions) {
    this.#config = options.config;
    this.#notBeforeStore = options.notBeforeStore;
    this.#metrics = options.metrics;
    this.#key =
      options.key ??
      createRemoteJWKSet(new URL(options.config.jwksUrl), {
        cacheMaxAge: 300_000,
        cooldownDuration: 30_000,
        timeoutDuration: options.config.introspectionTimeoutMs,
        [customFetch]: async (url, init) => {
          try {
            const response = await (options.jwksFetchImplementation ?? fetch)(url, init);
            this.#metrics.jwksRefreshes.inc({ outcome: response.ok ? "success" : "error" });
            return response;
          } catch (error) {
            this.#metrics.jwksRefreshes.inc({ outcome: "unavailable" });
            throw error;
          }
        },
      });
  }

  async authenticate(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        algorithms: ["RS256"],
        audience: this.#config.audience,
        clockTolerance: 5,
        issuer: this.#config.issuer,
      });
      const principal = principalFromClaims({ claims: payload, audience: this.#config.audience });
      if (principal.username !== null) {
        const cutoff = await this.#notBeforeStore.get({ username: principal.username });
        if (principal.issuedAt < cutoff) {
          throw unauthenticated(
            "The bearer token was issued before the enforced revocation cutoff.",
          );
        }
      }
      return principal;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      if (error instanceof joseErrors.JOSEError) {
        throw unauthenticated();
      }
      throw dependencyUnavailable("Signing keys are temporarily unavailable.");
    }
  }
}

type FetchLike = typeof fetch;

type IntrospectionAuthenticatorOptions = {
  config: ApiConfig;
  metrics: ApiMetrics;
  fetchImplementation?: FetchLike;
};

export class IntrospectionAuthenticator implements Authenticator {
  readonly #config: ApiConfig;
  readonly #metrics: ApiMetrics;
  readonly #fetch: FetchLike;

  constructor(options: IntrospectionAuthenticatorOptions) {
    if (options.config.introspectionClientSecret === null) {
      throw new Error("Introspection client credentials are not configured.");
    }
    this.#config = options.config;
    this.#metrics = options.metrics;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async authenticate(token: string): Promise<Principal> {
    const body = new URLSearchParams({ token });
    const credentials = Buffer.from(
      `${this.#config.introspectionClientId}:${this.#config.introspectionClientSecret}`,
      "utf8",
    ).toString("base64");

    let response: Response;
    try {
      response = await this.#fetch(this.#config.introspectionUrl, {
        method: "POST",
        headers: {
          authorization: `Basic ${credentials}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(this.#config.introspectionTimeoutMs),
      });
    } catch {
      this.#metrics.keycloakCalls.inc({ operation: "introspection", outcome: "unavailable" });
      throw dependencyUnavailable("Token introspection is temporarily unavailable.");
    }

    if (!response.ok) {
      this.#metrics.keycloakCalls.inc({ operation: "introspection", outcome: "error" });
      throw dependencyUnavailable("Token introspection is temporarily unavailable.");
    }

    let claims: Record<string, unknown>;
    try {
      claims = (await response.json()) as Record<string, unknown>;
    } catch {
      this.#metrics.keycloakCalls.inc({ operation: "introspection", outcome: "error" });
      throw dependencyUnavailable("Token introspection is temporarily unavailable.");
    }
    this.#metrics.keycloakCalls.inc({ operation: "introspection", outcome: "success" });
    if (claims.active !== true || claims.iss !== this.#config.issuer) {
      throw unauthenticated();
    }
    return principalFromClaims({ claims, audience: this.#config.audience });
  }
}

type CacheEntry = { principal: Principal; expiresAtMs: number };

export class CachedAuthenticator implements Authenticator {
  readonly #delegate: Authenticator;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #metrics: ApiMetrics;
  readonly #entries = new Map<string, CacheEntry>();

  constructor(options: {
    delegate: Authenticator;
    ttlSeconds: number;
    maxEntries: number;
    metrics: ApiMetrics;
  }) {
    this.#delegate = options.delegate;
    this.#ttlMs = options.ttlSeconds * 1000;
    this.#maxEntries = options.maxEntries;
    this.#metrics = options.metrics;
  }

  async authenticate(token: string): Promise<Principal> {
    const key = createHash("sha256").update(token).digest("hex");
    const now = Date.now();
    const cached = this.#entries.get(key);
    if (cached !== undefined && cached.expiresAtMs > now) {
      this.#entries.delete(key);
      this.#entries.set(key, cached);
      this.#metrics.introspectionCache.inc({ outcome: "hit" });
      return cached.principal;
    }
    this.#entries.delete(key);
    this.#metrics.introspectionCache.inc({ outcome: "miss" });

    const principal = await this.#delegate.authenticate(token);
    const expiresAtMs = Math.min(now + this.#ttlMs, principal.expiresAt * 1000);
    if (expiresAtMs > now) {
      this.#entries.set(key, { principal, expiresAtMs });
      while (this.#entries.size > this.#maxEntries) {
        const oldest = this.#entries.keys().next().value;
        if (oldest === undefined) break;
        this.#entries.delete(oldest);
      }
    }
    return principal;
  }
}

export function bearerToken(authorization: string | undefined): string {
  if (authorization === undefined) {
    throw unauthenticated();
  }
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (match?.[1] === undefined) {
    throw unauthenticated();
  }
  return match[1];
}
