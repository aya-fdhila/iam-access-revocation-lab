import type { JobConfig } from "./config.js";

type TokenResponse = { access_token?: unknown; expires_in?: unknown };
export type TokenLease = { accessToken: string; reused: boolean };

export class ClientCredentialsTokenCache {
  #cached: { accessToken: string; usableUntil: number } | null = null;

  constructor(
    private readonly config: JobConfig,
    private readonly request: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<TokenLease> {
    const now = this.now();
    if (this.#cached !== null && now < this.#cached.usableUntil) {
      return { accessToken: this.#cached.accessToken, reused: true };
    }
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const response = await this.request(this.config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!response.ok) throw new Error(`Token endpoint returned ${response.status}.`);
    const body = (await response.json()) as TokenResponse;
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new Error("Token endpoint returned an invalid response.");
    }
    const usableUntil = now + Math.max(1, body.expires_in * 1000 - this.config.renewBeforeMs);
    this.#cached = { accessToken: body.access_token, usableUntil };
    return { accessToken: body.access_token, reused: false };
  }
}
