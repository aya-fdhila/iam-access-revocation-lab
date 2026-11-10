# ADR 0004: Add per-user not-before enforcement

- Status: Accepted
- Date: 2026-11-08

## Context

An otherwise valid locally checked access token can survive logout or account disablement until `exp`. The experiment needs to demonstrate a way to shorten that window without introspecting every request.

## Decision

The local API will compare a validated token's `iat` with a per-user not-before timestamp set by the privileged offboarding workflow. Tokens issued before that timestamp are rejected as unauthenticated.

The API stores per-user not-before timestamps in an authenticated Redis instance on the internal application network. Only the local-JWT validation mode consults this cutoff, preserving the experiment's intended introspection and cached-introspection revocation behavior. An internal endpoint protected by the generated offboarding secret applies monotonic updates so retries cannot move a cutoff backwards.

The store uses a persistent volume and fails access closed with a service-unavailable response when the local validator cannot read required revocation state. It is not coupled to Keycloak's PostgreSQL database and is never routed through the public HTTPS edge.

## Consequences

- Offboarding can invalidate local-mode tokens promptly without a Keycloak call per request.
- Each local-mode authenticated request performs one internal store lookup.
- State distribution, restart behavior, endpoint authentication, and timestamp consistency become security-relevant.
- The API must not accept an untrusted caller's not-before update.
- Introspection modes continue to measure Keycloak state and the configured positive-cache window rather than being short-circuited by the local cutoff.
