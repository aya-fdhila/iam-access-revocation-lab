import { describe, expect, it } from "vitest";

import { decodeJwt, stringArrayClaim, tokenFingerprint } from "../src/tokens";

describe("token helpers", () => {
  it("decodes URL-safe JWT claims and nested roles", () => {
    const claims = { preferred_username: "aya", realm_access: { roles: ["admins"] } };
    const payload = btoa(JSON.stringify(claims))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const decoded = decodeJwt(`header.${payload}.signature`);
    expect(decoded).toEqual(claims);
    expect(stringArrayClaim(decoded, ["realm_access", "roles"])).toEqual(["admins"]);
  });

  it("returns a non-secret stable fingerprint", () => {
    expect(tokenFingerprint("secret-token")).toMatch(/^memory:[0-9a-f]{8}$/);
    expect(tokenFingerprint("secret-token")).not.toContain("secret-token");
  });
});
