# OpenLDAP

This directory contains the executable OpenLDAP foundation:

- `ldif/seed.ldif.template` defines deterministic users, groups, the password policy, and the least-privilege Keycloak bind identity.
- `config/slapd.ldif` defines the MDB database, ACLs, `memberOf`, referential integrity, and password-policy overlays.
- `scripts/start.sh` builds ephemeral runtime configuration and initializes only an empty persistent database.
- `scripts/seed-groups.sh` applies initial memberships once so the `memberOf` overlay records reverse membership.
- `scripts/verify.sh` proves read-only federation access, membership, account lockout/unlock, and stable entry UUIDs.

Secrets are injected from the ignored `.env` file and converted to hashes before seed import. The development port binds only to loopback; containers use the internal `identity` network. Use `make ldap-test` for the supported acceptance proof.
