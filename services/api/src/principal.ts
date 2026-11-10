import type { JWTPayload } from "jose";

import { unauthenticated } from "./errors.js";

export type Principal = {
  subject: string;
  username: string | null;
  clientId: string | null;
  scopes: ReadonlySet<string>;
  roles: ReadonlySet<string>;
  issuedAt: number;
  expiresAt: number;
};

function stringClaim(claims: JWTPayload, name: string): string | null {
  const value = claims[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rolesClaim(claims: JWTPayload): ReadonlySet<string> {
  const realmAccess = claims.realm_access;
  if (typeof realmAccess !== "object" || realmAccess === null || !("roles" in realmAccess)) {
    return new Set();
  }
  const roles = realmAccess.roles;
  return new Set(
    Array.isArray(roles) ? roles.filter((role): role is string => typeof role === "string") : [],
  );
}

export function audienceIncludes(audience: JWTPayload["aud"], expected: string): boolean {
  return typeof audience === "string"
    ? audience === expected
    : Array.isArray(audience) && audience.includes(expected);
}

export function principalFromClaims(options: {
  claims: JWTPayload;
  audience: string;
  now?: number;
}): Principal {
  const { claims, audience, now = Date.now() / 1000 } = options;
  if (
    typeof claims.sub !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    (typeof claims.nbf === "number" && claims.nbf > now + 5) ||
    !audienceIncludes(claims.aud, audience)
  ) {
    throw unauthenticated();
  }

  return {
    subject: claims.sub,
    username: stringClaim(claims, "preferred_username"),
    clientId: stringClaim(claims, "azp") ?? stringClaim(claims, "client_id"),
    scopes: new Set((stringClaim(claims, "scope") ?? "").split(" ").filter(Boolean)),
    roles: rolesClaim(claims),
    issuedAt: claims.iat,
    expiresAt: claims.exp,
  };
}
