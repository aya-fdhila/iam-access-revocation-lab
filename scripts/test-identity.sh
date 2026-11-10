#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
env_file="${ENV_FILE:-${repo_root}/.env}"
cert_file="${repo_root}/infra/certs/localhost.pem"
compose=(docker compose -f "${repo_root}/docker-compose.yml" -f "${repo_root}/docker-compose.dev.yml")

for command in curl jq base64; do
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
  local token="$1"
  local payload padding
  payload="$(cut -d. -f2 <<<"${token}" | tr '_-' '/+')"
  padding=$(( (4 - ${#payload} % 4) % 4 ))
  payload="${payload}$(printf '%*s' "${padding}" '' | tr ' ' '=')"
  printf '%s' "${payload}" | base64 --decode 2>/dev/null
}

discovery="$(curl --silent --show-error --fail --cacert "${cert_file}" \
  https://auth.localhost/realms/company/.well-known/openid-configuration)"
jq -e '.issuer == "https://auth.localhost/realms/company"' <<<"${discovery}" >/dev/null || {
  printf '%s\n' 'OIDC discovery returned an unexpected issuer.' >&2
  exit 1
}

ali_response="$(printf '%s' "${ldap_password}" | curl --silent --show-error --fail --cacert "${cert_file}" \
  --data-urlencode grant_type=password \
  --data-urlencode client_id=test-cli \
  --data-urlencode username=ali \
  --data-urlencode password@- \
  https://auth.localhost/realms/company/protocol/openid-connect/token)"
ali_token="$(jq -er '.access_token' <<<"${ali_response}")"
ali_claims="$(decode_payload "${ali_token}")"
jq -e '
  .preferred_username == "ali" and
  .email == "ali@iam.localhost" and
  ((.aud == "api") or (.aud | type == "array" and index("api") != null)) and
  (.scope | split(" ") | index("docs:read") != null) and
  (.scope | split(" ") | index("docs:write") != null) and
  (.realm_access.roles | index("employees") != null) and
  (.realm_access.roles | index("managers") == null) and
  (.realm_access.roles | index("admins") == null)
' <<<"${ali_claims}" >/dev/null || {
  printf '%s\n' 'Ali token did not contain the required username, email, API audience, document scopes, and employees role.' >&2
  exit 1
}

for administrator in aya yassmine; do
  admin_response="$(printf '%s' "${ldap_password}" | curl --silent --show-error --fail --cacert "${cert_file}" \
    --data-urlencode grant_type=password \
    --data-urlencode client_id=test-cli \
    --data-urlencode "username=${administrator}" \
    --data-urlencode password@- \
    https://auth.localhost/realms/company/protocol/openid-connect/token)"
  admin_token="$(jq -er '.access_token' <<<"${admin_response}")"
  admin_claims="$(decode_payload "${admin_token}")"
  jq -e --arg username "${administrator}" '
    .preferred_username == $username and
    (.realm_access.roles | index("admins") != null) and
    (.realm_access.roles | index("employees") == null) and
    (.realm_access.roles | index("managers") == null)
  ' <<<"${admin_claims}" >/dev/null || {
    printf '%s did not receive the LDAP-derived admins role.\n' "${administrator}" >&2
    exit 1
  }
done

job_response="$(printf '%s' "${job_secret}" | curl --silent --show-error --fail --cacert "${cert_file}" \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode client_id=job \
  --data-urlencode client_secret@- \
  https://auth.localhost/realms/company/protocol/openid-connect/token)"
job_token="$(jq -er '.access_token' <<<"${job_response}")"
job_claims="$(decode_payload "${job_token}")"
jq -e '
  .azp == "job" and
  .preferred_username == "service-account-job" and
  ((.aud == "api") or (.aud | type == "array" and index("api") != null)) and
  (.scope | split(" ") | index("reports:run") != null)
' <<<"${job_claims}" >/dev/null || {
  printf '%s\n' 'Job token did not contain the required service identity, API audience, and reports scope.' >&2
  exit 1
}

invalid_job_result="$(curl --silent --show-error --cacert "${cert_file}" \
  --write-out $'\n%{http_code}' \
  --data-urlencode grant_type=client_credentials \
  --data-urlencode client_id=job \
  --data-urlencode client_secret=definitely-not-the-job-secret \
  https://auth.localhost/realms/company/protocol/openid-connect/token)"
invalid_job_status="${invalid_job_result##*$'\n'}"
invalid_job_body="${invalid_job_result%$'\n'*}"
[[ "${invalid_job_status}" == 401 ]] && jq -e '.error == "invalid_client" or .error == "unauthorized_client"' <<<"${invalid_job_body}" >/dev/null || {
  printf '%s\n' 'Job client did not reject an invalid client secret.' >&2
  exit 1
}

public_admin_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --cacert "${cert_file}" \
  https://auth.localhost/admin/)"
[[ "${public_admin_status}" == 404 ]] || { printf 'Public host exposed the admin route (HTTP %s).\n' "${public_admin_status}" >&2; exit 1; }

alias_header_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --cacert "${cert_file}" \
  --header 'X_Auth_User: attacker' \
  https://auth.localhost/realms/company/.well-known/openid-configuration)"
[[ "${alias_header_status}" == 400 ]] || { printf 'Traefik did not reject an aliasing request header (HTTP %s).\n' "${alias_header_status}" >&2; exit 1; }

encoded_path_status="$(curl --silent --path-as-is --output /dev/null --write-out '%{http_code}' --cacert "${cert_file}" \
  https://auth.localhost/realms/company%2Funexpected)"
[[ "${encoded_path_status}" == 400 ]] || { printf 'Traefik did not reject an encoded slash in the request path (HTTP %s).\n' "${encoded_path_status}" >&2; exit 1; }

admin_status="$(curl --silent --output /dev/null --write-out '%{http_code}' --cacert "${cert_file}" \
  https://admin-auth.localhost/admin/)"
case "${admin_status}" in
  200|301|302|303) ;;
  *) printf 'Admin host did not route to Keycloak (HTTP %s).\n' "${admin_status}" >&2; exit 1 ;;
esac

"${compose[@]}" run --rm -e VERIFY_EVENTS=true keycloak-config >/dev/null
printf '%s\n' 'Identity acceptance passed: HTTPS, route separation, LDAP role claims, and service credentials.'
