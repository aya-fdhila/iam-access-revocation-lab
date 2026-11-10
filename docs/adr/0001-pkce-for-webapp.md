# ADR 0001: Use Authorization Code with PKCE for the web app

- Status: Accepted
- Date: 2026-11-08

## Context

The React application runs in an untrusted browser and cannot safely hold a client secret. The course requires a standards-based interactive OAuth/OIDC flow.

## Decision

Use Authorization Code with PKCE using the S256 challenge method. Keep tokens in memory and use refresh-token rotation for silent renewal. Do not use the implicit flow or password grant for the browser application.

## Consequences

- An intercepted authorization code cannot be exchanged without the verifier.
- The browser client remains public and contains no secret.
- Page reload loses in-memory tokens unless the OIDC flow restores the session.
- ROPC may exist only in isolated deterministic test helpers and must be identified as deprecated lab support.
