#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_root}"

command -v jq >/dev/null 2>&1 || {
  printf '%s\n' 'Missing required command: jq (needed by make check to validate the Keycloak realm JSON).' >&2
  exit 1
}

required_files=(
  Makefile
  docker-compose.yml
  docker-compose.dev.yml
  docker-compose.prod.yml
  .env.example
  docs/development.md
  docs/ci.md
  docs/demo-script.md
  .github/dependabot.yml
  .github/workflows/ci.yml
  infra/ldap/config/slapd.ldif
  infra/ldap/ldif/seed.ldif.template
  infra/ldap/scripts/start.sh
  infra/ldap/scripts/seed-groups.sh
  infra/ldap/scripts/verify.sh
  infra/keycloak/realm.json
  infra/keycloak/scripts/verify-realm.sh
  infra/traefik/traefik.yml
  infra/traefik/dynamic.yml
  infra/redis/start.sh
  infra/prometheus/prometheus.yml
  infra/prometheus/offboarding.rules.yml
  infra/grafana/provisioning/datasources/prometheus.yml
  infra/grafana/provisioning/dashboards/provider.yml
  infra/grafana/dashboards/access-horizon.json
  services/api/Dockerfile
  services/api/package.json
  services/api/package-lock.json
  services/webapp/Dockerfile
  services/webapp/package.json
  services/webapp/package-lock.json
  services/job/Dockerfile
  services/job/package.json
  services/job/package-lock.json
  services/offboarding/cli.py
  pyproject.toml
  tests/requirements.txt
  tests/test_matrix.py
  tests/offboarding_run.py
  tests/bench.py
  tests/plots.py
  tests/validate_results.py
  tests/report_metrics.py
  report/report.md
  report/evidence-summary.json
  scripts/require-certs.sh
  scripts/test-identity.sh
  scripts/test-webapp.sh
  scripts/test-job.sh
  scripts/supply-chain.sh
)

for file in "${required_files[@]}"; do
  [[ -f "${file}" ]] || { printf 'Missing required bootstrap file: %s\n' "${file}" >&2; exit 1; }
done

for script in scripts/*.sh; do
  bash -n "${script}"
done
bash -n infra/keycloak/scripts/verify-realm.sh
jq -e '
  .realm == "company" and
  (.defaultDefaultClientScopes | index("roles")) != null and
  any(
    .clientScopes[];
    .name == "roles" and
    any(.protocolMappers[]; .protocolMapper == "oidc-usermodel-client-role-mapper")
  )
' infra/keycloak/realm.json >/dev/null

docker compose -f docker-compose.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.dev.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet

if grep -nE '(^|:)latest([[:space:]]|$)' docker-compose*.yml; then
  printf '%s\n' 'Unpinned latest image reference detected.' >&2
  exit 1
fi

is_forbidden_tracked_file() {
  local path="$1"
  local filename="${path##*/}"

  [[ "${filename}" == .env.example ]] && return 1
  [[ "${filename}" == .env || "${filename}" == .env.* || "${filename}" =~ \.(pem|key|p12|pfx|crt|cer|der|p8)$ ]]
}

for forbidden_fixture in .env .env.production config/.env.local server.pem server.crt server.cer signing.der signing.p8; do
  is_forbidden_tracked_file "${forbidden_fixture}" || {
    printf 'Tracked-secret detector missed fixture: %s\n' "${forbidden_fixture}" >&2
    exit 1
  }
done
if is_forbidden_tracked_file .env.example; then
  printf '%s\n' 'Tracked-secret detector rejected the committed environment template.' >&2
  exit 1
fi

while IFS= read -r -d '' tracked_file; do
  if is_forbidden_tracked_file "${tracked_file}"; then
    printf 'Tracked secret or certificate-like file detected: %s\n' "${tracked_file}" >&2
    exit 1
  fi
done < <(git ls-files -z)

temp_dir="$(mktemp -d)"
trap 'rm -rf -- "${temp_dir}"' EXIT
test_env="${temp_dir}/generated.env"
scripts/gen-secrets.sh "${test_env}" >/dev/null
first_hash="$(sha256sum "${test_env}" | awk '{print $1}')"
scripts/gen-secrets.sh "${test_env}" >/dev/null
second_hash="$(sha256sum "${test_env}" | awk '{print $1}')"
[[ "${first_hash}" == "${second_hash}" ]] || { printf '%s\n' 'Secret generation is not idempotent.' >&2; exit 1; }

for key in LDAP_ADMIN_PASSWORD LDAP_BIND_PASSWORD LDAP_USER_PASSWORD KC_ADMIN_PASSWORD KC_DB_PASSWORD JOB_CLIENT_SECRET API_CLIENT_SECRET NOT_BEFORE_REDIS_PASSWORD OFFBOARDING_API_SECRET BENCHMARK_API_SECRET GRAFANA_ADMIN_PASSWORD; do
  value="$(awk -F= -v wanted_key="${key}" '$1 == wanted_key {sub(/^[^=]*=/, ""); print; exit}' "${test_env}")"
  [[ "${value}" =~ ^[0-9a-f]{64}$ ]] || { printf 'Secret %s was not generated correctly.\n' "${key}" >&2; exit 1; }
done

test_cert_dir="${temp_dir}/certs"
MKCERT_BIN="${repo_root}/tests/bootstrap/fake-mkcert.sh" CERT_DIR="${test_cert_dir}" scripts/gen-certs.sh >/dev/null
cert_hash="$(sha256sum "${test_cert_dir}/localhost.pem" | awk '{print $1}')"
key_hash="$(sha256sum "${test_cert_dir}/localhost-key.pem" | awk '{print $1}')"
[[ "$(stat -c '%a' "${test_cert_dir}/localhost-key.pem")" == 600 ]] || { printf '%s\n' 'Generated certificate key does not have mode 0600.' >&2; exit 1; }
MKCERT_BIN="${repo_root}/tests/bootstrap/fake-mkcert.sh" CERT_DIR="${test_cert_dir}" scripts/gen-certs.sh >/dev/null
[[ "${cert_hash}" == "$(sha256sum "${test_cert_dir}/localhost.pem" | awk '{print $1}')" ]] || { printf '%s\n' 'Certificate generation overwrote an existing certificate.' >&2; exit 1; }
[[ "${key_hash}" == "$(sha256sum "${test_cert_dir}/localhost-key.pem" | awk '{print $1}')" ]] || { printf '%s\n' 'Certificate generation overwrote an existing key.' >&2; exit 1; }

check_base_ref="${CHECK_BASE_REF:-}"
if [[ -z "${check_base_ref}" ]]; then
  if git show-ref --verify --quiet refs/remotes/origin/main; then
    check_base_ref=origin/main
  elif git rev-parse --verify --quiet HEAD^ >/dev/null; then
    check_base_ref=HEAD^
  fi
fi

if [[ -n "${check_base_ref}" ]]; then
  git rev-parse --verify "${check_base_ref}^{commit}" >/dev/null
  merge_base="$(git merge-base "${check_base_ref}" HEAD)"
  git diff --check "${merge_base}...HEAD"
else
  git show --check --format= HEAD
fi
git diff --check
git diff --cached --check
printf '%s\n' 'Bootstrap validation passed.'
