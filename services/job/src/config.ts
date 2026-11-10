export type JobConfig = {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  reportsUrl: string;
  intervalMs: number;
  renewBeforeMs: number;
  port: number;
};

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): JobConfig {
  const clientSecret = environment.JOB_CLIENT_SECRET;
  if (clientSecret === undefined || clientSecret.length < 16) {
    throw new Error("JOB_CLIENT_SECRET must contain at least 16 characters.");
  }
  return {
    tokenUrl:
      environment.OIDC_TOKEN_URL ??
      "http://keycloak:8080/realms/company/protocol/openid-connect/token",
    clientId: environment.OIDC_CLIENT_ID ?? "job",
    clientSecret,
    reportsUrl: environment.REPORTS_URL ?? "http://api-introspection:3000/reports/run",
    intervalMs: positiveInteger(environment.JOB_INTERVAL_MS, 60_000, "JOB_INTERVAL_MS"),
    renewBeforeMs: positiveInteger(
      environment.TOKEN_RENEW_BEFORE_MS,
      10_000,
      "TOKEN_RENEW_BEFORE_MS",
    ),
    port: positiveInteger(environment.JOB_HEALTH_PORT, 3001, "JOB_HEALTH_PORT"),
  };
}
