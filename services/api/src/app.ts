import { randomUUID, timingSafeEqual } from "node:crypto";
import { performance } from "node:perf_hooks";

import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

import { type Authenticator, bearerToken } from "./auth.js";
import type { ApiConfig } from "./config.js";
import { ApiError, forbidden, unauthenticated } from "./errors.js";
import { ApiMetrics } from "./metrics.js";
import type { NotBeforeStore } from "./not-before.js";
import {
  canReadAllDocuments,
  DocumentRepository,
  requireAdmin,
  requireDeletableDocument,
  requireDocumentRole,
  requireJob,
  requireReadableDocument,
  requireScope,
} from "./policy.js";
import type { Principal } from "./principal.js";

declare module "fastify" {
  interface FastifyRequest {
    principal?: Principal;
    requestStartedAt?: number;
  }
}

type BuildAppOptions = {
  config: ApiConfig;
  authenticator: Authenticator;
  notBeforeStore?: NotBeforeStore;
  metrics?: ApiMetrics;
};

const errorSchema = {
  type: "object",
  required: ["error", "requestId"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message"],
      properties: { code: { type: "string" }, message: { type: "string" } },
    },
    requestId: { type: "string" },
  },
} as const;

function principalFor(request: FastifyRequest): Principal {
  if (request.principal === undefined) throw unauthenticated();
  return request.principal;
}

function secretMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const metrics = options.metrics ?? new ApiMetrics(options.config.validationMode);
  const documents = new DocumentRepository();
  const publicPrefix =
    options.config.validationMode === "cached-introspection"
      ? "cached"
      : options.config.validationMode;
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: {
      level: options.config.logLevel,
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.x-offboarding-secret",
          "req.headers.x-benchmark-secret",
        ],
        censor: "[REDACTED]",
      },
    },
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      callback(null, origin === undefined || origin === options.config.webappOrigin);
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["authorization", "content-type"],
    exposedHeaders: ["x-request-id"],
    maxAge: 600,
  });

  await app.register(swagger, {
    openapi: {
      info: { title: "IAM Access Revocation Lab API", version: "1.0.0" },
      servers: [{ url: `https://api.localhost/${publicPrefix}` }],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.addHook("onRequest", async (request, reply) => {
    request.requestStartedAt = performance.now();
    reply.header("x-request-id", request.id);
  });
  app.addHook("onResponse", async (request, reply) => {
    const startedAt = request.requestStartedAt ?? performance.now();
    const route = request.routeOptions.url ?? "unmatched";
    metrics.requestDuration.observe(
      { method: request.method, route, status_class: `${Math.floor(reply.statusCode / 100)}xx` },
      (performance.now() - startedAt) / 1000,
    );
  });

  app.setErrorHandler(async (error, request, reply) => {
    const isValidationError = typeof error === "object" && error !== null && "validation" in error;
    const apiError =
      error instanceof ApiError
        ? error
        : isValidationError
          ? new ApiError({
              statusCode: 400,
              errorCode: "invalid_request",
              message: "The request did not match the documented API contract.",
            })
          : new ApiError({
              statusCode: 500,
              errorCode: "internal_error",
              message: "Internal server error.",
            });
    if (apiError.challenge)
      reply.header("www-authenticate", 'Bearer realm="iam-access-revocation-lab"');
    if (!(error instanceof ApiError) && !isValidationError) {
      request.log.error({ err: error }, "request.failed");
    }
    await reply.status(apiError.statusCode).send({
      error: { code: apiError.errorCode, message: apiError.message },
      requestId: request.id,
    });
  });

  const authenticate = async (request: FastifyRequest): Promise<void> => {
    const end = metrics.authenticationDuration.startTimer();
    try {
      request.principal = await options.authenticator.authenticate(
        bearerToken(request.headers.authorization),
      );
      metrics.authenticationResults.inc({ outcome: "accepted" });
      end({ outcome: "accepted" });
    } catch (error) {
      const outcome =
        error instanceof ApiError && error.statusCode === 503 ? "unavailable" : "rejected";
      metrics.authenticationResults.inc({ outcome });
      end({ outcome });
      throw error;
    }
  };

  app.get(
    "/health",
    { schema: { summary: "Check API process health", response: { 200: { type: "object" } } } },
    async () => ({ status: "ok", mode: options.config.validationMode }),
  );

  app.get(
    "/metrics",
    { schema: { summary: "Expose Prometheus metrics" } },
    async (_request, reply) => {
      reply.type(metrics.registry.contentType);
      return metrics.registry.metrics();
    },
  );

  app.post(
    "/internal/metrics/reset",
    {
      schema: {
        summary: "Reset process metrics for a controlled benchmark",
        headers: { type: "object", properties: { "x-benchmark-secret": { type: "string" } } },
        response: { 204: { type: "null" }, 401: errorSchema },
      },
    },
    async (request, reply) => {
      const provided = request.headers["x-benchmark-secret"];
      if (
        typeof provided !== "string" ||
        !secretMatches(provided, options.config.benchmarkApiSecret)
      ) {
        throw unauthenticated("Internal endpoint authentication failed.");
      }
      metrics.reset();
      return reply.status(204).send();
    },
  );

  app.get("/openapi.json", { schema: { summary: "Return the OpenAPI document" } }, async () =>
    app.swagger(),
  );

  app.get(
    "/me",
    {
      preHandler: authenticate,
      schema: { summary: "Return the authenticated identity", response: { 401: errorSchema } },
    },
    async (request) => {
      const principal = principalFor(request);
      return {
        subject: principal.subject,
        username: principal.username,
        clientId: principal.clientId,
        scopes: [...principal.scopes].sort(),
        roles: [...principal.roles].sort(),
        issuedAt: principal.issuedAt,
        expiresAt: principal.expiresAt,
        mode: options.config.validationMode,
      };
    },
  );

  app.get(
    "/documents",
    {
      preHandler: authenticate,
      schema: {
        summary: "List authorized documents",
        response: { 401: errorSchema, 403: errorSchema },
      },
    },
    async (request) => {
      const principal = principalFor(request);
      requireScope(principal, "docs:read");
      requireDocumentRole(principal);
      const visible = canReadAllDocuments(principal)
        ? documents.list()
        : documents.list().filter((document) => document.owner === principal.username);
      return { documents: visible };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/documents/:id",
    {
      preHandler: authenticate,
      schema: {
        summary: "Read one authorized document",
        response: { 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request) => {
      const principal = principalFor(request);
      requireScope(principal, "docs:read");
      requireDocumentRole(principal);
      const document = documents.get(Number.parseInt(request.params.id, 10));
      requireReadableDocument(principal, document);
      return document;
    },
  );

  app.post<{ Body: { title: string } }>(
    "/documents",
    {
      preHandler: authenticate,
      schema: {
        summary: "Create an owned document",
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: { title: { type: "string", minLength: 1, maxLength: 120 } },
        },
        response: { 401: errorSchema, 403: errorSchema },
      },
    },
    async (request, reply) => {
      const principal = principalFor(request);
      requireScope(principal, "docs:write");
      requireDocumentRole(principal);
      if (principal.username === null)
        throw forbidden("wrong_identity_type", "A user identity is required.");
      return reply.status(201).send(documents.create(principal.username, request.body.title));
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/documents/:id",
    {
      preHandler: authenticate,
      schema: {
        summary: "Delete an owned or administrator-authorized document",
        response: { 401: errorSchema, 403: errorSchema, 404: errorSchema },
      },
    },
    async (request, reply) => {
      const principal = principalFor(request);
      requireScope(principal, "docs:write");
      requireDocumentRole(principal);
      const document = documents.get(Number.parseInt(request.params.id, 10));
      requireDeletableDocument(principal, document);
      documents.delete(document.id);
      return reply.status(204).send();
    },
  );

  app.get(
    "/admin/users",
    {
      preHandler: authenticate,
      schema: {
        summary: "List safe laboratory user profiles",
        response: { 401: errorSchema, 403: errorSchema },
      },
    },
    async (request) => {
      requireAdmin(principalFor(request));
      return {
        users: [
          { username: "aya", displayName: "Aya Fdhila" },
          { username: "yassmine", displayName: "Yassmine Ghali" },
          { username: "ali", displayName: "Ali Mansouri" },
          { username: "marwa", displayName: "Marwa Trabelsi" },
          { username: "marwen", displayName: "Marwen Ben Salem" },
        ],
      };
    },
  );

  app.post(
    "/reports/run",
    {
      preHandler: authenticate,
      schema: {
        summary: "Run the scheduled service report",
        response: { 401: errorSchema, 403: errorSchema },
      },
    },
    async (request) => {
      requireJob(principalFor(request));
      return { status: "completed", report: "access-summary" };
    },
  );

  if (options.config.validationMode === "local" && options.notBeforeStore !== undefined) {
    if (options.config.offboardingApiSecret === null) {
      throw new Error("OFFBOARDING_API_SECRET is required for local validation.");
    }
    const offboardingApiSecret = options.config.offboardingApiSecret;
    app.put<{ Params: { username: string }; Body: { timestamp: number } }>(
      "/internal/not-before/:username",
      {
        schema: {
          summary: "Apply a monotonic per-user revocation cutoff",
          headers: { type: "object", properties: { "x-offboarding-secret": { type: "string" } } },
          body: {
            type: "object",
            required: ["timestamp"],
            additionalProperties: false,
            properties: { timestamp: { type: "integer", minimum: 1 } },
          },
          response: { 401: errorSchema },
        },
      },
      async (request) => {
        const provided = request.headers["x-offboarding-secret"];
        if (typeof provided !== "string" || !secretMatches(provided, offboardingApiSecret)) {
          throw unauthenticated("Internal endpoint authentication failed.");
        }
        const timestamp = await options.notBeforeStore?.setMonotonic({
          username: request.params.username,
          timestamp: request.body.timestamp,
        });
        return { username: request.params.username, notBefore: timestamp };
      },
    );
  }

  return app;
}
