# ADR 0003: Compare local validation with introspection

- Status: Accepted
- Date: 2026-11-08

## Context

Local JWT validation is fast and resilient but normally cannot observe server-side session changes before token expiry. Introspection provides current authorization-server state at the cost of latency and dependency load. A short cache trades some immediacy for fewer calls.

## Decision

Deploy one API implementation in three configured modes: local JWKS validation, uncached RFC 7662 introspection, and introspection with a bounded positive-result cache. Reuse exactly the same post-authentication authorization policy in all modes.

## Consequences

- Measurements isolate validation strategy rather than route-policy differences.
- Introspection mode fails closed when Keycloak is unavailable.
- Local mode can continue with a valid cached JWKS but accepts an old token until expiry unless not-before enforcement rejects it.
- Cached introspection intentionally creates a revocation window no longer than the lesser of cache TTL and remaining token lifetime.
