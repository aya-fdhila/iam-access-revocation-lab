# Keycloak

`realm.json` is the declarative `company` realm imported by the digest-pinned Keycloak container on a fresh PostgreSQL database. It defines the read-only LDAP provider and mappers, realm roles, OIDC clients, scopes, API audience, short token/session lifetimes, refresh-token rotation, and event storage/logging.

`scripts/verify-realm.sh` uses the matching image's `kcadm.sh` to read the materialized realm after startup. Traefik does not start unless this job succeeds. Manual administration-console clicks are not part of the startup path.

Startup import is fresh-database-only. Any realm change must increment the `lab.config.revision` value in both files; an existing database with an older revision fails closed until the operator explicitly approves the guarded volume reset. This preserves routine restart state while making configuration drift visible.

Keycloak application traffic stays internal on port 8080. Its health and metrics management interface is port 9000 and is loopback-only in the development override.

The `test-cli` public direct-grant client exists only to make local acceptance deterministic. Every shipped Compose profile is a local lab profile, including the production-style override; none is a public deployment profile. Remove or replace `test-cli` before adapting this realm for any externally reachable environment.
