# LDAP Configuration

`slapd.ldif` builds `cn=config` on every start while keeping directory data in the persistent volume. It loads the MDB backend and the `memberOf`, referential-integrity, and password-policy overlays.

The root DN can manage directory data. The `keycloak-bind` service identity can read users and groups but cannot mutate them. Users may read their own entry, and anonymous access is limited to password authentication. The default password policy locks an account after three failed binds until an administrator unlocks it.
