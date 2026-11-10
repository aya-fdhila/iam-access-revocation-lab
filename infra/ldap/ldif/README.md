# LDAP Seed Data

`seed.ldif.template` is versioned, non-secret LDIF for the lab users, role groups, password policy, administrator, and read-only Keycloak service identity. Startup replaces only the password-hash placeholders with hashes derived from generated local secrets; plaintext values are never written into the repository.

The seed is imported only when the LDAP database is empty. Initial group memberships are then applied online exactly once so the `memberOf` overlay generates reverse links. Existing persistent identities are never overwritten during routine startup.
