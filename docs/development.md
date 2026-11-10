# Local Development Contract

This is the canonical local workflow for the complete identity, API, web, job, offboarding, and observability stack.

## Prerequisites

- Git
- GNU Make
- Bash
- OpenSSL
- Docker Engine or Docker Desktop with Compose v2
- `mkcert` plus the platform NSS tools when generating browser-trusted local certificates
- Node.js 24 or newer and npm for TypeScript formatting, type checks, builds, and unit tests
- Python 3.14 or newer; `make python-deps` creates the ignored pinned virtual environment
- `jq` for `make check`; `curl` and GNU `base64` for runtime acceptance checks
- Network access to the official Gitleaks and Trivy registries/databases for `make supply-chain`

Run all project commands from the repository root. On Windows, use the WSL Ubuntu shell with Docker Desktop WSL integration enabled.

Install the locked TypeScript development dependencies once after cloning:

```bash
npm --prefix services/api ci
npm --prefix services/webapp ci
npm --prefix services/job ci
```

## Commands

```bash
make help
make secrets
make certs     # requires mkcert and updates the local development trust store
make config
make check
make images
make supply-chain
make up
make ldap-test
make identity-test
make api-test
make web-test
make browser-test
make job-test
make observability-test
make test
make matrix-evidence
make offboard USER=marwa
make bench
make export
make logs
make down
```

`make secrets` creates `.env` with mode 0600, fills only missing or placeholder secret values, never prints them, and leaves existing real values unchanged.

`make certs` creates one ignored local certificate/key pair covering the planned `.localhost` hostnames. It is safe to rerun when both files exist. It fails rather than guessing if only one file exists.

`make config` validates the base, development, and production-style Compose models without starting containers.

`make check` is the current validation floor: shell/realm/workflow policy, all Compose models, pinned-image policy, immutable GitHub Action pins, secret/certificate safeguards, idempotent secret generation, formatting, TypeScript compilation, API/console/job unit tests, and Git whitespace checks. It compares committed changes with `origin/main` by default; set `CHECK_BASE_REF` when validating against another base.

`make images` builds the project-owned API, console, and scheduled-job images without changing running containers. `make supply-chain` runs a redacted full-history Gitleaks scan, scans locked dependencies, exports each project image to a temporary archive, and scans it with Trivy without granting the scanner Docker-socket access. Fixed `HIGH` and `CRITICAL` findings fail closed. See [the CI contract](ci.md) for pins, recovery, and exception policy.

`make observability-test` runs the live authorization matrix to create bounded traffic, verifies every Prometheus target and required IAM series, validates the Prometheus configuration and generated rules with `promtool`, scans labels and output for identity or secret leakage, and reads the provisioned Grafana datasource and dashboard back through their APIs.

## Identity runtime

`make up` starts the pinned OpenLDAP service and applies the initial group memberships once on a fresh persistent volume. The directory contains Aya Fdhila and Yassmine Ghali as administrators, Marwen Ben Salem as a manager, Ali Mansouri as an employee, and Marwa Trabelsi as the employee used in offboarding experiments.

`make ldap-test` proves that the Keycloak bind identity can read but cannot write, all group-derived `memberOf` values exist, three failed logins lock Marwa's account, an administrator can unlock it, and Marwa's entry UUID survives a container restart.

`make up` then starts PostgreSQL and Keycloak, imports `infra/keycloak/realm.json` on a fresh database, verifies the materialized realm through `kcadm.sh`, and starts Traefik only after those checks pass. PostgreSQL, LDAP, and Keycloak's application port remain on internal networks. Development exposes only LDAP and Keycloak's management health/metrics port on loopback; browser traffic uses Traefik at port 443.

Keycloak startup import deliberately does not overwrite an existing realm. Every realm change must increment `lab.config.revision` in `realm.json` and the matching expected revision in `verify-realm.sh`. A stale database then fails startup verification with recovery guidance instead of silently serving old policy. Applying the new revision requires the explicitly guarded destructive reset and operator approval; routine restart never rewrites identity state.

`make identity-test` verifies the exact issuer over HTTPS, confirms the public authentication host returns 404 for `/admin/`, confirms the separate administration host routes correctly, and obtains short-lived tokens without printing them. Ali must receive `aud=api`, `docs:read`, `docs:write`, and `employees`; Aya and Yassmine must each receive `admins`; the `job` service account must receive `aud=api` and `reports:run` with its expected identity.

## API runtime

One immutable API image runs as `api-local`, `api-introspection`, and `api-cached-introspection`. Traefik exposes them at `/local`, `/introspection`, and `/cached` on `https://api.localhost`. All modes share claim parsing and authorization policy. Local validation verifies RS256, issuer, audience, lifetime, and a per-user cutoff stored in authenticated Redis. Introspection modes call Keycloak; cached introspection keeps only bounded, short-lived positive results in process memory. Required dependency failure returns 503 rather than allowing access.

The internal `PUT /internal/not-before/:username` endpoint is available only inside `api-local`, requires the generated offboarding secret, accepts only monotonic timestamps, and has no public Traefik route. The benchmark-only `POST /internal/metrics/reset` endpoint exists in each API process, uses a separate generated secret, and is also excluded from every public route. Redis persists append-only revocation state across routine restarts.

`make api-test` obtains tokens without printing them and proves matching policy results across all three modes. It includes anonymous, ownership, role, scope, administrator, service-identity, tampered-token, revocation-persistence, identity-provider-outage, and log-redaction checks. The outage check briefly stops and restarts Keycloak; the cleanup trap restores it if the check exits early.

## Browser console and scheduled workload

Traefik serves the non-root web container at `https://app.localhost`. The public `webapp` client uses Authorization Code with PKCE S256. Only the transient authorization request is kept in `sessionStorage`; processed ID and access tokens use an in-memory OIDC store and disappear on reload. The UI renders claims rather than raw token strings, switches among the three API modes, and makes 401, 403, and network failures visible.

`make web-test` runs the component/type/build gate, reads the deployed HTTPS page and security headers, confirms Keycloak advertises S256 and accepts the console's exact scope request, and proves API CORS emits an allow-origin header only for `https://app.localhost`. `make browser-test` then uses Chrome with normal certificate verification to prove the full PKCE, callback, API, refresh rotation, reload, revocation, and logout path.

The `job` container is attached only to the internal workload network. It requests a `job` Client Credentials token, caches it in process memory until ten seconds before expiry, calls the introspection-mode report route on a fixed schedule, and exposes only an internal health endpoint. `make job-test` proves token renewal behavior in unit tests and checks a real successful JSON log without printing or leaking the token or client secret.

The `webapp` is a public OAuth client using Authorization Code with PKCE S256. Processed tokens, including the rotating refresh token used for automatic silent renewal, live only in JavaScript memory; `sessionStorage` is limited to the short-lived authorization transaction. This is intentionally observable for the lab. Production applications should generally use a backend-for-frontend (BFF) and an HTTP-only browser session cookie instead.

## Observability runtime

Prometheus scrapes the three API modes, Keycloak's management endpoint, and itself on a private network with no published host port. Its seven-day persistent store and rules are lab evidence, not an identity source of truth. `tests/prometheus_rules.py` deterministically converts the complete canonical `results/offboarding.csv` into bounded recording rules; `make export` regenerates them and `make check` rejects stale output.

Grafana is available at `https://grafana.localhost`. The Prometheus datasource and the **Access Horizon — IAM observability** dashboard are provisioned from Git, so no UI setup is required. Anonymous users have the Viewer role; administrative login uses the generated `GRAFANA_ADMIN_PASSWORD` from the ignored `.env`. The stable presentation link is `https://grafana.localhost/d/iam-access-revocation/access-horizon`.

`make down` stops containers and preserves the LDAP volume. `make reset CONFIRM=reset` deletes local runtime volumes; it is deliberately guarded and requires explicit operator approval. Never use reset to recover from a routine restart.

## Offboarding and evidence

`make offboard USER=marwa` runs the immediate automated workflow and writes a JSONL step receipt under ignored `results/raw/offboarding-receipts/`. Marwa is the only accepted subject because her employee membership is the experiment's declared recovery state; refusing other users prevents an administrator or manager from retaining or receiving the wrong role during a generic restore. Group removal, account lock, Keycloak disable/logout, optional RFC 7009 revocation, and not-before updates are individually retry-safe. The command never writes a token or secret to a receipt. A known experiment refresh token is delivered to the CLI through standard input; the ordinary command has no token to persist and records that specific step as skipped after invalidating all user sessions.

`make test` writes the live matrix sample to ignored `results/raw/matrix-latest.csv`, so normal validation cannot dirty or replace committed evidence. `make matrix-evidence` is the explicit publication command. The matrix briefly sets a one-second realm access-token lifespan to obtain a genuinely expired signed token, restores the exact previous lifespan in a `finally` path, waits past the API clock tolerance, and proves all three modes return 401.

`make measure` runs the full 1/5/15-minute experiment with three repetitions. It separates T0 group removal from T1 account lock. Baseline mode stops there; automated mode adds Keycloak and local-API invalidation. The runner polls once per second, carries refresh-token rotation forward as a chain, and distinguishes authentication (`GET /me`) from document authorization (`GET /documents/3`). An authorization observation can have a negative delay from T1 when the T0 group removal takes effect before the later lock. Censored observations remain explicit. The runner restores Marwa after each run and restores the five-minute realm lifespan in a `finally` path.

Run measurements only in a distinct Compose project created for experiments. Stop any stack already using ports 443, 1389, and 9000, then set `COMPOSE_PROJECT_NAME` consistently for `make up`, `make measure`, and `make down`. Never use `make reset` as experiment cleanup. `make bench` uses 1,000 requests at concurrency 10 per mode and derives Keycloak calls from reset process metrics. `make export` validates complete canonical CSV before producing PNG charts.

## Startup order

The runtime starts in this order:

1. Persistent OpenLDAP and PostgreSQL
2. Keycloak and its configuration-as-code verification job
3. Traefik HTTPS routing
4. API validation modes and persistent not-before store
5. Web app, job, and offboarding experiment tooling
6. Prometheus and Grafana

Each dependency will have a health check. Dependent services will wait for health rather than sleeping for a fixed interval.

## Restart rules

- Configuration-only Compose validation does not require a runtime restart.
- A rebuilt service image must be recreated before its behavior is considered validated.
- LDAP schema or fresh-seed changes do not rewrite an existing database. Validate them with a separately named Compose project or, after explicit approval, a destructive reset.
- `make down` preserves volumes; `make reset CONFIRM=reset` is the separate destructive path.

## Current limitations

- The privileged offboarding workflow remains a host-side CLI by design; the browser never receives LDAP, Keycloak administration, revocation, or Grafana administration credentials.
- LDAP is exposed only on `127.0.0.1:1389` by the development override. Inter-service access stays on the internal identity network.
- Keycloak management health/metrics are exposed only on `127.0.0.1:9000` by the development override. The administration UI uses `https://admin-auth.localhost`; it is intentionally unavailable through `https://auth.localhost/admin/`.
- Traefik reads the mode-0600 certificate key as `LOCAL_UID`/`LOCAL_GID` (default `1000:1000`). Set those values in `.env` to `id -u` and `id -g` on hosts with a different local user ID.
- `make browser-test` requires Google Chrome plus a trusted `mkcert` CA. It uses normal certificate validation and takes roughly four minutes so automatic renewal is observed against the real five-minute token lifetime. On this host, `mkcert` and NSS tooling are installed under `~/.local/bin`, the CA is trusted only in the user's Chrome/Firefox NSS store, and the generated certificate expires in February 2029.
