# System Tests and Experiments

- `test_matrix.py` runs the complete 7-profile × 8-route × 3-validation-mode policy contract, adds 9 signed-token negative cases, and atomically writes all 177 rows to `results/matrix.csv` only when every exact REST status (`200`, `201`, `204`, `401`, or `403`) matches.
- `offboarding_run.py` executes baseline and automated T0/T1 protocols, separately measures token authentication and document authorization, records observed and censored outcomes, and writes `results/offboarding.csv` after a complete run.
- `bench.py` applies a fixed request/concurrency load and writes metric-derived latency, throughput, and Keycloak-call evidence.
- `validate_results.py` refuses incomplete canonical datasets.
- `plots.py` deterministically regenerates PNG assets from canonical CSV only.

The live tools keep passwords, client secrets, access tokens, and refresh tokens in memory. Only normalized non-secret observations may enter `results/`.
