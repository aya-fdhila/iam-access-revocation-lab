# Prometheus

`prometheus.yml` scrapes Prometheus itself, the three API validation modes, and Keycloak's management endpoint over the private `observability` network. Prometheus has no published host port and retains local lab data for seven days.

`offboarding.rules.yml` contains bounded recording rules generated from the canonical experiment CSV. Regenerate it with `make export` and verify it with `make check`; do not hand-edit measured delay values.
