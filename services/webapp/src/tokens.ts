export type JsonClaims = Record<string, unknown>;

export function decodeJwtPart(token: string | undefined, index: 0 | 1): JsonClaims | null {
  if (token === undefined) return null;
  const payload = token.split(".")[index];
  if (payload === undefined) return null;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as JsonClaims;
  } catch {
    return null;
  }
}

export function decodeJwt(token: string | undefined): JsonClaims | null {
  return decodeJwtPart(token, 1);
}

export function tokenFingerprint(token: string | undefined): string {
  if (token === undefined) return "not issued";
  let hash = 0x811c9dc5;
  for (const character of token) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `memory:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function stringArrayClaim(claims: JsonClaims | null, path: string[]): string[] {
  let value: unknown = claims;
  for (const key of path) {
    if (typeof value !== "object" || value === null || !(key in value)) return [];
    value = (value as JsonClaims)[key];
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function spaceDelimitedClaim(claims: JsonClaims | null, key: string): string[] {
  const value = claims?.[key];
  return typeof value === "string" ? value.split(" ").filter(Boolean) : [];
}
