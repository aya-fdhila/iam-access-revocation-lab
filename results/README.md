# Results

Canonical evidence consists of `matrix.csv`, `offboarding.csv`, and `bench.csv`; `matrix.png`, `offboarding.png`, and `benchmark.png` are derived only from those files. `make export` validates the full 60/300/900-second, three-repetition protocol before replacing presentation assets.

Raw receipts and incomplete work belong in ignored `results/raw/`. Censored and failed observations remain explicit CSV rows; the tooling never silently drops them or replaces measured values with hypotheses.

`delay_from_T1_s` may be negative for document authorization: this means the T0 LDAP group removal was observed before the later T1 account lock. Authentication and authorization are separate elements so that behavior is not misreported as token revocation.

## Current measured result

The 2026-11-08 run completed all three repetitions at 60, 300, and 900 seconds:

- baseline local, uncached-introspection, and cached-introspection authentication ended at token expiry—about 58, 298, and 898 seconds after T1;
- automated local and uncached-introspection authentication rejection averaged 0.37–0.39 seconds after T1;
- automated cached-introspection rejection was observed 3 seconds after T1, corresponding to its 5-second positive-cache window from T0;
- uncached introspection removed document authorization about 0.14 seconds after T0 even while the token remained active; cached introspection reflected that role change at 5 seconds from T0;
- all nine baseline refresh chains remained active through the observation deadline and are explicitly recorded as censored.

At 1,000 requests with concurrency 10, local validation produced 1,710 requests/s at 5.344 ms p50 and zero Keycloak calls per request; uncached introspection produced 1,231 requests/s at 6.815 ms p50 and exactly one Keycloak call per request; cached introspection produced 1,437 requests/s at 6.424 ms p50 and 0.008 Keycloak calls per request. These numbers describe the committed run environment in `bench.csv`, not a production capacity claim.
