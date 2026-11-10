import { Counter, collectDefaultMetrics, Histogram, Registry } from "@prometheus-io/client";

import type { ValidationMode } from "./config.js";

export class ApiMetrics {
  readonly registry = new Registry();
  readonly requestDuration: Histogram<"method" | "route" | "status_class">;
  readonly authenticationDuration: Histogram<"outcome">;
  readonly authenticationResults: Counter<"outcome">;
  readonly keycloakCalls: Counter<"operation" | "outcome">;
  readonly jwksRefreshes: Counter<"outcome">;
  readonly introspectionCache: Counter<"outcome">;

  constructor(mode: ValidationMode) {
    this.registry.setDefaultLabels({ mode });
    collectDefaultMetrics({ prefix: "iam_api_", register: this.registry });
    this.requestDuration = new Histogram({
      name: "iam_api_http_request_duration_seconds",
      help: "API request duration by stable route and status class.",
      labelNames: ["method", "route", "status_class"],
      registers: [this.registry],
    });
    this.authenticationDuration = new Histogram({
      name: "iam_api_authentication_duration_seconds",
      help: "Bearer authentication duration by outcome.",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
    this.authenticationResults = new Counter({
      name: "iam_api_authentication_results_total",
      help: "Bearer authentication results by bounded outcome.",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
    this.keycloakCalls = new Counter({
      name: "iam_api_keycloak_calls_total",
      help: "Calls to Keycloak by operation and outcome.",
      labelNames: ["operation", "outcome"],
      registers: [this.registry],
    });
    this.jwksRefreshes = new Counter({
      name: "iam_api_jwks_refreshes_total",
      help: "Remote JWKS fetches by bounded outcome.",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
    this.introspectionCache = new Counter({
      name: "iam_api_introspection_cache_total",
      help: "Positive introspection cache lookups by outcome.",
      labelNames: ["outcome"],
      registers: [this.registry],
    });
  }

  reset(): void {
    this.registry.resetMetrics();
  }
}
