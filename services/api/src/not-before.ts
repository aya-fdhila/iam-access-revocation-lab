import { createClient, type RedisClientType } from "redis";

import { dependencyUnavailable } from "./errors.js";

export interface NotBeforeStore {
  get(options: { username: string }): Promise<number>;
  setMonotonic(options: { username: string; timestamp: number }): Promise<number>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class RedisNotBeforeStore implements NotBeforeStore {
  readonly #client: RedisClientType;

  constructor(options: { url: string; password: string }) {
    this.#client = createClient({ url: options.url, password: options.password });
  }

  async connect(): Promise<void> {
    this.#client.on("error", () => undefined);
    await this.#client.connect();
  }

  async get(options: { username: string }): Promise<number> {
    try {
      const value = await this.#client.get(this.#key(options.username));
      return value === null ? 0 : Number.parseInt(value, 10);
    } catch {
      throw dependencyUnavailable("Revocation state is temporarily unavailable.");
    }
  }

  async setMonotonic(options: { username: string; timestamp: number }): Promise<number> {
    try {
      const result = await this.#client.eval(
        "local current = tonumber(redis.call('GET', KEYS[1]) or '0'); local candidate = tonumber(ARGV[1]); if candidate >= current then redis.call('SET', KEYS[1], ARGV[1]); return candidate; end; return current;",
        { keys: [this.#key(options.username)], arguments: [String(options.timestamp)] },
      );
      return Number(result);
    } catch {
      throw dependencyUnavailable("Revocation state is temporarily unavailable.");
    }
  }

  async ping(): Promise<void> {
    try {
      await this.#client.ping();
    } catch {
      throw dependencyUnavailable("Revocation state is temporarily unavailable.");
    }
  }

  async close(): Promise<void> {
    if (this.#client.isOpen) {
      await this.#client.quit();
    }
  }

  #key(username: string): string {
    return `not-before:${username}`;
  }
}

export class MemoryNotBeforeStore implements NotBeforeStore {
  readonly #values = new Map<string, number>();

  async get(options: { username: string }): Promise<number> {
    return this.#values.get(options.username) ?? 0;
  }

  async setMonotonic(options: { username: string; timestamp: number }): Promise<number> {
    const next = Math.max(this.#values.get(options.username) ?? 0, options.timestamp);
    this.#values.set(options.username, next);
    return next;
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {}
}
