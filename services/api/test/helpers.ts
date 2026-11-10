import type { Authenticator } from "../src/auth.js";
import type { ApiConfig, ValidationMode } from "../src/config.js";
import { unauthenticated } from "../src/errors.js";
import type { Principal } from "../src/principal.js";

export function testConfig(mode: ValidationMode = "local"): ApiConfig & {
  introspectionClientSecret: string;
  notBeforeRedisPassword: string;
  offboardingApiSecret: string;
  benchmarkApiSecret: string;
} {
  return {
    host: "127.0.0.1",
    port: 3000,
    logLevel: "silent",
    webappOrigin: "https://app.localhost",
    validationMode: mode,
    issuer: "https://auth.localhost/realms/company",
    audience: "api",
    jwksUrl: "http://keycloak.test/certs",
    introspectionUrl: "http://keycloak.test/introspect",
    introspectionClientId: "api",
    introspectionClientSecret: "a".repeat(32),
    introspectionTimeoutMs: 500,
    introspectionCacheTtlSeconds: 5,
    introspectionCacheMaxEntries: 2,
    notBeforeRedisUrl: "redis://not-before-store:6379",
    notBeforeRedisPassword: "b".repeat(32),
    offboardingApiSecret: "c".repeat(32),
    benchmarkApiSecret: "d".repeat(32),
  };
}

export function principal(options: Partial<Principal> = {}): Principal {
  return {
    subject: "subject-ali",
    username: "ali",
    clientId: "test-cli",
    scopes: new Set(["docs:read", "docs:write"]),
    roles: new Set(["employees"]),
    issuedAt: 1_800_000_000,
    expiresAt: 1_900_000_000,
    ...options,
  };
}

export class TokenMapAuthenticator implements Authenticator {
  constructor(private readonly principals: ReadonlyMap<string, Principal>) {}

  async authenticate(token: string): Promise<Principal> {
    const resolved = this.principals.get(token);
    if (resolved === undefined) throw unauthenticated();
    return resolved;
  }
}
