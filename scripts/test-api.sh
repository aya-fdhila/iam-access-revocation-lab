#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
env_file="${ENV_FILE:-${repo_root}/.env}"
cert_file="${repo_root}/infra/certs/localhost.pem"
compose=(docker compose -f "${repo_root}/docker-compose.yml" -f "${repo_root}/docker-compose.dev.yml")
keycloak_stopped=false

cleanup() {
  if [[ "${keycloak_stopped}" == true ]]; then
    "${compose[@]}" start keycloak >/dev/null 2>&1 || true
    "${compose[@]}" up -d --wait keycloak >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

for command in curl jq base64 docker; do
  command -v "${command}" >/dev/null 2>&1 || { printf 'Missing required command: %s\n' "${command}" >&2; exit 1; }
done
[[ -f "${env_file}" ]] || { printf '%s\n' 'Missing .env; run make secrets first.' >&2; exit 1; }
"${repo_root}/scripts/require-certs.sh"

env_value() {
  local key="$1"
  awk -F= -v wanted_key="${key}" '$1 == wanted_key {sub(/^[^=]*=/, ""); print; exit}' "${env_file}"
}

ldap_password="$(env_value LDAP_USER_PASSWORD)"
job_secret="$(env_value JOB_CLIENT_SECRET)"
[[ -n "${ldap_password}" && -n "${job_secret}" ]] || { printf '%s\n' 'Required generated secrets are missing.' >&2; exit 1; }

decode_payload() {
  local token="$1" payload padding
  payload="$(cut -d. -f2 <<<"${token}" | tr '_-' '/+')"
  padding=$(( (4 - ${#payload} % 4) % 4 ))
  payload="${payload}$(printf '%*s' "${padding}" '' | tr ' ' '=')"
  printf '%s' "${payload}" | base64 --decode 2>/dev/null
}

user_token() {
  local username="$1" scope="${2:-}"
  local args=(
    --silent --show-error --fail --cacert "${cert_file}"
    --data-urlencode grant_type=password
    --data-urlencode client_id=test-cli
    --data-urlencode "username=${username}"
    --data-urlencode password@-
  )
  [[ -z "${scope}" ]] || args+=(--data-urlencode "scope=${scope}")
  printf '%s' "${ldap_password}" | curl "${args[@]}" \
    https://auth.localhost/realms/company/protocol/openid-connect/token | jq -er '.access_token'
}

job_token() {
  printf '%s' "${job_secret}" | curl --silent --show-error --fail --cacert "${cert_file}" \
    --data-urlencode grant_type=client_credentials \
    --data-urlencode client_id=job \
    --data-urlencode client_secret@- \
    https://auth.localhost/realms/company/protocol/openid-connect/token | jq -er '.access_token'
}

request_status() {
  local mode="$1" method="$2" path="$3" token="${4:-}"
  local args=(--silent --show-error --output /dev/null --write-out '%{http_code}' --cacert "${cert_file}" --request "${method}")
  [[ -z "${token}" ]] || args+=(--header "Authorization: Bearer ${token}")
  curl "${args[@]}" "https://api.localhost/${mode}${path}"
}

[[ "$("${compose[@]}" exec -T api-local id -u)" == 1000 ]] || {
  printf '%s\n' 'API container is not running as its unprivileged runtime user.' >&2
  exit 1
}
[[ "$("${compose[@]}" exec -T not-before-store id -u)" == 999 ]] || {
  printf '%s\n' 'Redis container is not running as its unprivileged runtime user.' >&2
  exit 1
}
"${compose[@]}" exec -T api-local node -e \
  'if (process.env.API_CLIENT_SECRET !== undefined) process.exit(1)'
for service in api-introspection api-cached-introspection; do
  "${compose[@]}" exec -T "${service}" node -e \
    'if (process.env.NOT_BEFORE_REDIS_PASSWORD !== undefined || process.env.OFFBOARDING_API_SECRET !== undefined) process.exit(1)'
done

for mode in local introspection cached; do
  metrics_body=""
  curl --silent --show-error --fail --cacert "${cert_file}" \
    "https://api.localhost/${mode}/openapi.json" | jq -e --arg url "https://api.localhost/${mode}" \
      '.info.title == "IAM Access Revocation Lab API" and .servers[0].url == $url' >/dev/null
  metrics_body="$(curl --silent --show-error --fail --cacert "${cert_file}" \
    "https://api.localhost/${mode}/metrics")"
  grep -q '^iam_api_' <<<"${metrics_body}"
done

expect_status() {
  local expected="$1" description="$2" mode="$3" method="$4" path="$5" token="${6:-}"
  local actual
  actual="$(request_status "${mode}" "${method}" "${path}" "${token}")"
  [[ "${actual}" == "${expected}" ]] || {
    printf '%s: expected HTTP %s, got %s.\n' "${description}" "${expected}" "${actual}" >&2
    exit 1
  }
}

ali_token="$(user_token ali)"
marwen_token="$(user_token marwen)"
aya_token="$(user_token aya admin)"
service_token="$(job_token)"

for mode in local introspection cached; do
  expect_status 401 "${mode} anonymous request" "${mode}" GET /documents/2
  expect_status 200 "${mode} owner read" "${mode}" GET /documents/2 "${ali_token}"
  expect_status 403 "${mode} cross-owner refusal" "${mode}" GET /documents/3 "${ali_token}"
  expect_status 200 "${mode} manager read" "${mode}" GET /documents/3 "${marwen_token}"
  expect_status 403 "${mode} employee admin refusal" "${mode}" GET /admin/users "${ali_token}"
  expect_status 200 "${mode} administrator read" "${mode}" GET /admin/users "${aya_token}"
  expect_status 403 "${mode} user report refusal" "${mode}" POST /reports/run "${ali_token}"
  expect_status 200 "${mode} job report" "${mode}" POST /reports/run "${service_token}"
  expect_status 403 "${mode} job document refusal" "${mode}" GET /documents "${service_token}"
  expect_status 401 "${mode} tampered token refusal" "${mode}" GET /me "${ali_token}x"
done

expect_status 404 'public internal endpoint isolation' local PUT /internal/not-before/ali
expect_status 404 'public benchmark endpoint isolation' local POST /internal/metrics/reset

cutoff="$(( $(jq -er '.iat' <<<"$(decode_payload "${ali_token}")") + 1 ))"
"${compose[@]}" exec -T -e "CUTOFF=${cutoff}" api-local node - <<'NODE' >/dev/null
const response = await fetch("http://127.0.0.1:3000/internal/not-before/ali", {
  method: "PUT",
  headers: {"content-type": "application/json", "x-offboarding-secret": process.env.OFFBOARDING_API_SECRET},
  body: JSON.stringify({timestamp: Number(process.env.CUTOFF)}),
});
if (!response.ok) process.exit(1);
NODE

expect_status 401 'local not-before refusal' local GET /me "${ali_token}"
expect_status 200 'introspection unaffected by local cutoff' introspection GET /me "${ali_token}"
expect_status 200 'cached introspection unaffected by local cutoff' cached GET /me "${ali_token}"

"${compose[@]}" restart api-local >/dev/null
"${compose[@]}" up -d --wait api-local >/dev/null
expect_status 401 'cutoff persistence after API restart' local GET /me "${ali_token}"
"${compose[@]}" restart not-before-store >/dev/null
"${compose[@]}" up -d --wait not-before-store api-local >/dev/null
expect_status 401 'cutoff persistence after Redis restart' local GET /me "${ali_token}"

while (( $(date +%s) <= cutoff )); do sleep 1; done
fresh_ali_token="$(user_token ali)"
expect_status 200 'newer token accepted after cutoff' local GET /me "${fresh_ali_token}"

"${compose[@]}" stop keycloak >/dev/null
keycloak_stopped=true
expect_status 200 'known local token during IdP outage' local GET /me "${fresh_ali_token}"
expect_status 503 'introspection fails closed during IdP outage' introspection GET /me "${fresh_ali_token}"
"${compose[@]}" start keycloak >/dev/null
"${compose[@]}" up -d --wait keycloak >/dev/null
keycloak_stopped=false

log_file="$(mktemp)"
trap 'rm -f "${log_file}"; cleanup' EXIT
"${compose[@]}" logs --no-color api-local api-introspection api-cached-introspection >"${log_file}"
for sensitive_value in "${ali_token}" "${fresh_ali_token}" "${job_secret}" "$(env_value OFFBOARDING_API_SECRET)" "$(env_value BENCHMARK_API_SECRET)"; do
  if grep -Fq -- "${sensitive_value}" "${log_file}"; then
    printf '%s\n' 'API logs exposed a tested credential or token.' >&2
    exit 1
  fi
done
rm -f "${log_file}"
trap cleanup EXIT

printf '%s\n' 'API acceptance passed: three-mode policy parity, refusal cases, persistent revocation, outage behavior, and log redaction.'
