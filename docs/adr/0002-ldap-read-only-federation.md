# ADR 0002: Federate LDAP in read-only mode

- Status: Accepted
- Date: 2026-11-08

## Context

OpenLDAP is the authority for employee identities and groups. Allowing Keycloak to mutate the directory would expand privilege and blur ownership during offboarding experiments.

## Decision

Configure Keycloak LDAP federation as read-only using a dedicated least-privilege bind account. Map LDAP groups to Keycloak realm roles. Account and group changes originate in LDAP; Keycloak administration is used for session logout, token revocation, and identity-provider state required by the experiment.

## Consequences

- Directory ownership and audit reasoning stay clear.
- Keycloak cannot repair or mutate LDAP records.
- Offboarding must coordinate LDAP state with Keycloak sessions explicitly.
- Tests must prove the bind account can read required attributes but cannot write them.
