# Presentation Demo Script

This is a 12–15 minute demonstration path. It uses the validated `iam-presentation` stack and avoids
destructive reset. Keep the committed charts open as a fallback before starting.

## Before the presentation

From the repository root:

```bash
export COMPOSE_PROJECT_NAME=iam-presentation
docker compose -f docker-compose.yml -f docker-compose.dev.yml ps
make export
```

Keep this terminal open so every later `docker compose` and `make` command targets the validated
presentation project rather than an empty directory-derived Compose project.

All services should be healthy. Open these tabs in order:

1. [Project console](https://app.localhost)
2. [Keycloak account/realm](https://auth.localhost/realms/company/account)
3. [Local API health](https://api.localhost/local/health)
4. [Grafana dashboard](https://grafana.localhost/d/iam-access-revocation/access-horizon)
5. [Architecture](architecture.md)
6. [Authorization model](authorization-model.md)
7. [Technical report](../report/report.md)

Use a private terminal to retrieve the generated demonstration password if needed:

```bash
grep '^LDAP_USER_PASSWORD=' .env
```

Do not project that terminal, paste the password into slides/chat, or commit it. All interactive lab
users share this generated local-only value. The presentation identities are:

| Username | Person | Role boundary | Best use in demo |
|---|---|---|---|
| `ali` | Ali Mansouri | employee | owner success and cross-owner refusal |
| `marwen` | Marwen Ben Salem | manager | cross-owner manager success |
| `aya` | Aya Fdhila | administrator | administrator page; request the `admin` scope |
| `yassmine` | Yassmine Ghali | administrator | second administrator proof |
| `marwa` | Marwa Trabelsi | employee/offboarding subject | offboarding timeline |

Do not use the Keycloak administrator password for normal sign-in. Grafana is already available as
an anonymous viewer, so its generated administrator password is not needed during the demonstration.

## 1. Research question and architecture — 2 minutes

Show `docs/architecture.md`.

Say: “The question is not only whether an account is disabled. It is how long an already-issued
access or refresh token can still reach an API. LDAP owns people and groups, Keycloak owns sessions
and tokens, and the API still owns resource authorization.”

Point out these trust boundaries:

- Traefik is the only public edge.
- Keycloak's LDAP account is read-only.
- PostgreSQL, Redis, and Prometheus are private.
- The same API policy runs after local, introspection, and cached-introspection authentication.
- Grafana is viewer-only for the presentation.

## 2. PKCE authentication and token meaning — 2 minutes

Open the console and select **Sign in with Keycloak**. Sign in as `ali` using the generated
`LDAP_USER_PASSWORD` value.

Show:

- preferred username and LDAP-derived `employees` role;
- access-token issuer, API audience, scopes, expiry countdown, and rotation state;
- the access token and ID token side by side without exposing raw token strings.

Say: “The ID token tells the client who signed in. The API accepts only the access token. Tokens are
kept in memory, not localStorage; a production SPA should normally use a backend-for-frontend.”

Expected result: PKCE S256 login succeeds, the API audience is present, and reload clears the local
browser session.

## 3. Explain 200, 401, and 403 — 3 minutes

Open **Documents** in the console and keep Ali signed in.

1. Read Ali's own document: expect **200**.
2. Read Marwa's document as Ali: expect **403** because the token is valid but Ali is not owner,
   manager, or administrator.
3. Use a private/incognito request or the external matrix result for an anonymous call: expect
   **401** because no valid principal exists.
4. Switch local, introspection, and cached-introspection modes. Repeat the owner/cross-owner calls;
   policy results stay the same.

Show `results/matrix.png` or the matrix section of the report. State the measured summary:
177<!-- metric:matrix_rows -->/177<!-- metric:matrix_passes --> rows passed, with
75<!-- metric:matrix_status_200 --> HTTP 200,
15<!-- metric:matrix_status_201 --> HTTP 201,
9<!-- metric:matrix_status_204 --> HTTP 204,
30<!-- metric:matrix_status_401 --> authentication-refusal, and
48<!-- metric:matrix_status_403 --> authorization-refusal rows. The 201 and 204 rows are the exact
REST success codes for document creation and deletion.

If an interactive call fails, do not improvise policy. Show the committed matrix, then run:

```bash
make matrix-test
```

## 4. Machine identity — 1 minute

Show the scheduled-job status/log view or a recent secret-safe job log:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs --tail=5 job
```

Explain that the `job` client uses Client Credentials, caches its token until shortly before expiry,
and is the only identity allowed on `POST /reports/run`. A human user token receives 403. The job is
on the internal workload network and never receives browser or edge responsibilities.

## 5. Offboarding and residual access — 3 minutes

Use the console's offboarding view to explain the probes, then show `results/offboarding.png` and the
report's baseline/automated sections. For a live mutation, use only the retry-safe full workflow:

```bash
make offboard USER=marwa
```

Explain the timeline:

- **T0:** remove Marwa from `employees`; authorization can disappear before token authentication.
- **T1:** lock the LDAP account; new login stops, but old access/refresh state may remain.
- automated controls: Keycloak logout/revocation plus the API's durable per-user not-before cutoff.

Measured outcomes to state:

- baseline local authentication survived 58.000<!-- metric:baseline_local_auth_t1_mean_60s -->,
  297.667<!-- metric:baseline_local_auth_t1_mean_300s -->, and
  898.000<!-- metric:baseline_local_auth_t1_mean_900s --> seconds after T1 for the 1-, 5-, and
  15-minute tokens;
- all 9<!-- metric:baseline_refresh_censored --> baseline refresh chains remained active through the
  observation deadline;
- automated local rejection averaged 0.383<!-- metric:automated_local_auth_t1_mean --> seconds after
  T1, and uncached introspection also averaged
  0.383<!-- metric:automated_introspection_auth_t1_mean --> seconds;
- cached introspection rejected at 5.000<!-- metric:automated_cached_auth_t0_mean --> seconds from
  T0, or 3.000<!-- metric:automated_cached_auth_t1_mean --> seconds after T1 in this protocol.

After showing the refusals, explicitly restore Marwa, then confirm the complete policy matrix:

```bash
make restore USER=marwa
make matrix-test
```

If the live offboarding command is interrupted, do not delete volumes. Run
`make restore USER=marwa`; restore steps are retry-safe and record receipts. Then run
`make matrix-test`. Use the committed chart while recovery completes.

## 6. Observability and recommendation — 2 minutes

Open **Access Horizon — IAM Observability** in Grafana. Show:

- five healthy Prometheus targets;
- request outcomes and request/authentication p95;
- Keycloak/JWKS calls and introspection-cache hits;
- the measured offboarding-delay series.

Then show the report recommendation table:

- high risk: short token plus uncached introspection or mandatory local not-before automation;
- medium risk: five-minute token plus bounded cached introspection;
- low risk: local validation can minimize runtime dependency, but only with monitored offboarding
  automation—or the token remains valid nearly to expiry.

Say: “Local validation was fastest and made zero Keycloak calls per normal request. Uncached
introspection made one call per request. Cached introspection made
0.008<!-- metric:bench_cached_keycloak_calls_per_request --> calls per request in the benchmark and
bounded stale authentication to its five-second positive cache.”

## 7. Close — 1 minute

Finish with three points:

1. authentication and authorization are separate decisions;
2. account lock, session revocation, token expiry, and API not-before are separate controls; and
3. residual access is reduced by a complete, observable workflow—not by one token setting alone.

Show the reproducibility appendix and CI page. The project starts from a clean clone without
administration-console clicks, validates canonical evidence, and scans source, history, dependencies,
and runtime images.

## Recovery card

| Symptom | Safe response |
|---|---|
| A container is unhealthy | Run `docker compose -f docker-compose.yml -f docker-compose.dev.yml ps`, then inspect only that service with `docker compose ... logs --tail=100 SERVICE`. |
| Browser login fails | Confirm `https://auth.localhost/realms/company/.well-known/openid-configuration`; use the committed matrix/report while diagnosing. |
| API call fails unexpectedly | Open `https://api.localhost/local/health`, then compare the expected route policy in `docs/authorization-model.md`. |
| Grafana is empty | Run `make observability-test`; keep `results/*.png` open as the evidence fallback. |
| Offboarding is interrupted | Run `make restore USER=marwa`; do not reset volumes. Then run `make matrix-test` to prove recovery. |
| Time is short | Skip the live mutation. Show the matrix, offboarding chart, benchmark chart, and recommendation table; all are validated from committed CSV evidence. |

Never run `make reset`, `docker compose down -v`, delete identity data, or expose `.env` during the
presentation.
