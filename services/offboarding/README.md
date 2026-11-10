# Offboarding CLI

`cli.py` is the privileged, host-side workflow behind `make offboard USER=marwa`. It accepts only Marwa, the designated employee whose original role set is known, and refuses other lab users. It has explicit `t0`, `t1`, `full`, and `restore` phases so the experiment can keep LDAP-only baseline changes separate from automated revocation.

Each mutation appends a secret-free JSONL receipt with correlation ID, timestamps, outcome, and a bounded detail value. LDAP membership and lock changes, Keycloak enable/disable, session logout, refresh-token revocation, and the local API's monotonic not-before update are safe to retry. Refresh tokens are accepted only on standard input and never written to disk.

`make offboard USER=marwa` deliberately leaves the subject offboarded for observation. Run
`make restore USER=marwa` afterward to restore employee membership, unlock LDAP, enable the Keycloak
user, and invalidate any stale sessions. A newly issued token is later than the monotonic not-before
cutoff; the cutoff itself is not rolled back.
