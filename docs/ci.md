# Continuous Integration and Supply-Chain Checks

The `CI` workflow runs on pull requests, pushes to `main`, and manual dispatch. It has read-only repository permission and uses immutable full-commit pins for every external action.

## Required jobs

| Job | Proof |
|---|---|
| `Quality` | Locked Node/Python installs followed by the canonical `make check` floor |
| `Supply chain` | Project image builds, full-history Gitleaks, lockfile scanning, and image scanning |
| `Clean clone` | Fresh secrets/certificates, complete Compose startup, LDAP/identity checks, the 39-row matrix, workload checks, and observability acceptance |

The clean-clone job uses a unique `iam-ci-<run>-<attempt>` Compose project and deletes only that ephemeral runner's volumes in its unconditional cleanup step. It exports the runner's actual UID/GID so the non-root Traefik process can read the mode-0600 generated certificate key. It never targets a developer's named stack.

## Local supply-chain gate

Run:

```bash
make supply-chain
```

This builds the API, console, and job images, then runs official digest-pinned containers:

- Gitleaks scans complete Git history with redacted output.
- Trivy scans dependency manifests and each project image for fixed `HIGH` or `CRITICAL` vulnerabilities.

The first Trivy run downloads its vulnerability database from the official GHCR repository into the Docker volume `iam-access-revocation-trivy-cache`. Scanner network operations have a bounded 15-minute timeout. A network failure is not treated as a successful scan.

There is intentionally no general ignore file. If a future vulnerability cannot be fixed immediately, document the exact advisory, affected package/image, compensating control, owner, and expiry before adding a narrow exception.

## Recovery

- `Quality` failure: reproduce with `CHECK_BASE_REF=origin/main make check`.
- `Supply chain` failure: run `make supply-chain`; never paste an unredacted secret finding into an issue or PR.
- `Clean clone` failure: inspect the bounded service logs attached to the failed step, then reproduce in a separately named local Compose project. Do not reset the presentation stack.
- Cancelled jobs are safe to rerun. GitHub concurrency cancels superseded runs for the same branch, and cleanup is unconditional.

Once all three jobs have completed successfully at least once, the branch ruleset can require their exact GitHub check names. That repository setting is a separate operator-approved action.
