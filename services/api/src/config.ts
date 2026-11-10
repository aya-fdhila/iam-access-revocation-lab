import { z } from "zod";

export const validationModes = ["local", "introspection", "cached-introspection"] as const;
export type ValidationMode = (typeof validationModes)[number];

const environmentSchema = z
  .object({
    API_HOST: z.string().default("0.0.0.0"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    WEBAPP_ORIGIN: z.url().default("https://app.localhost"),
    VALIDATION_MODE: z.enum(validationModes).default("local"),
    OIDC_ISSUER: z.url().default("https://auth.localhost/realms/company"),
    OIDC_AUDIENCE: z.string().min(1).default("api"),
    OIDC_JWKS_URL: z
      .url()
      .default("http://keycloak:8080/realms/company/protocol/openid-connect/certs"),
    OIDC_INTROSPECTION_URL: z
      .url()
      .default("http://keycloak:8080/realms/company/protocol/openid-connect/token/introspect"),
    OIDC_INTROSPECTION_CLIENT_ID: z.string().min(1).default("api"),
    API_CLIENT_SECRET: z.string().min(16).optional(),
    INTROSPECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(2000),
    INTROSPECTION_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(60).default(5),
    INTROSPECTION_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(10_000).default(1000),
    NOT_BEFORE_REDIS_URL: z.url().default("redis://not-before-store:6379"),
    NOT_BEFORE_REDIS_PASSWORD: z.string().min(16).optional(),
    OFFBOARDING_API_SECRET: z.string().min(16).optional(),
    BENCHMARK_API_SECRET: z.string().min(16),
  })
  .superRefine((environment, context) => {
    if (environment.VALIDATION_MODE !== "local" && environment.API_CLIENT_SECRET === undefined) {
      context.addIssue({
        code: "custom",
        message: "API_CLIENT_SECRET is required for introspection modes.",
        path: ["API_CLIENT_SECRET"],
      });
    }
    if (environment.VALIDATION_MODE === "local") {
      for (const key of ["NOT_BEFORE_REDIS_PASSWORD", "OFFBOARDING_API_SECRET"] as const) {
        if (environment[key] === undefined) {
          context.addIssue({
            code: "custom",
            message: `${key} is required for local validation.`,
            path: [key],
          });
        }
      }
    }
  });

export type ApiConfig = {
  host: string;
  port: number;
  logLevel: string;
  webappOrigin: string;
  validationMode: ValidationMode;
  issuer: string;
  audience: string;
  jwksUrl: string;
  introspectionUrl: string;
  introspectionClientId: string;
  introspectionClientSecret: string | null;
  introspectionTimeoutMs: number;
  introspectionCacheTtlSeconds: number;
  introspectionCacheMaxEntries: number;
  notBeforeRedisUrl: string;
  notBeforeRedisPassword: string | null;
  offboardingApiSecret: string | null;
  benchmarkApiSecret: string;
};

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = environmentSchema.parse(environment);
  return {
    host: parsed.API_HOST,
    port: parsed.API_PORT,
    logLevel: parsed.LOG_LEVEL,
    webappOrigin: parsed.WEBAPP_ORIGIN,
    validationMode: parsed.VALIDATION_MODE,
    issuer: parsed.OIDC_ISSUER,
    audience: parsed.OIDC_AUDIENCE,
    jwksUrl: parsed.OIDC_JWKS_URL,
    introspectionUrl: parsed.OIDC_INTROSPECTION_URL,
    introspectionClientId: parsed.OIDC_INTROSPECTION_CLIENT_ID,
    introspectionClientSecret: parsed.API_CLIENT_SECRET ?? null,
    introspectionTimeoutMs: parsed.INTROSPECTION_TIMEOUT_MS,
    introspectionCacheTtlSeconds: parsed.INTROSPECTION_CACHE_TTL_SECONDS,
    introspectionCacheMaxEntries: parsed.INTROSPECTION_CACHE_MAX_ENTRIES,
    notBeforeRedisUrl: parsed.NOT_BEFORE_REDIS_URL,
    notBeforeRedisPassword: parsed.NOT_BEFORE_REDIS_PASSWORD ?? null,
    offboardingApiSecret: parsed.OFFBOARDING_API_SECRET ?? null,
    benchmarkApiSecret: parsed.BENCHMARK_API_SECRET,
  };
}
