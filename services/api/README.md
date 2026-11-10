# API Service

This TypeScript/Fastify resource server is deployed from one image in local-JWT, introspection, and cached-introspection modes. Claim normalization and authorization policy are shared so experiments isolate token validation behavior.

From the repository root:

```bash
npm --prefix services/api ci
npm --prefix services/api run check
make up
make api-test
```

Public HTTPS prefixes are `/local`, `/introspection`, and `/cached` at `api.localhost`. The local-only revocation mutation endpoint is intentionally absent from the public edge configuration. See the root README and `docs/development.md` for the route and failure-behavior contract.
