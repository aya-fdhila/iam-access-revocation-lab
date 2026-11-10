#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_root}"

cert_file="${repo_root}/infra/certs/localhost.pem"
[[ -f "${cert_file}" ]] || { printf '%s\n' 'Missing local certificate. Run make certs first.' >&2; exit 2; }

npm --prefix services/webapp run check
npm --prefix services/webapp run build >/dev/null

compose=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)
webapp_id="$("${compose[@]}" ps --quiet webapp)"
[[ -n "${webapp_id}" ]] || { printf '%s\n' 'The web application container is not running. Run make up first.' >&2; exit 2; }
[[ "$(docker inspect --format '{{.Config.User}}' "${webapp_id}")" == "1000:1000" ]]
project_name="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "${webapp_id}")"
mapfile -t webapp_networks < <(docker inspect "${webapp_id}" | jq -r '.[0].NetworkSettings.Networks | keys[]')
[[ "${#webapp_networks[@]}" -eq 1 && "${webapp_networks[0]}" == "${project_name}_edge" ]] || {
  printf '%s\n' 'The web application must attach only to the public edge network.' >&2
  exit 1
}

html="$(curl --fail --silent --show-error --cacert "${cert_file}" https://app.localhost/)"
grep -q '<title>Access Horizon</title>' <<<"${html}"

headers="$(curl --fail --silent --show-error --dump-header - --output /dev/null --cacert "${cert_file}" https://app.localhost/)"
grep -qi '^content-security-policy:.*frame-ancestors.*none' <<<"${headers}"
grep -qi '^permissions-policy:.*camera=()' <<<"${headers}"

allowed_headers="$(curl --fail --silent --show-error --dump-header - --output /dev/null --cacert "${cert_file}" \
  --request OPTIONS \
  --header 'Origin: https://app.localhost' \
  --header 'Access-Control-Request-Method: GET' \
  --header 'Access-Control-Request-Headers: authorization' \
  https://api.localhost/local/me)"
grep -qi '^access-control-allow-origin: https://app.localhost' <<<"${allowed_headers}"

refused_headers="$(curl --silent --show-error --dump-header - --output /dev/null --cacert "${cert_file}" \
  --request OPTIONS \
  --header 'Origin: https://attacker.invalid' \
  --header 'Access-Control-Request-Method: GET' \
  https://api.localhost/local/me)"
if grep -qi '^access-control-allow-origin:' <<<"${refused_headers}"; then
  printf '%s\n' 'Unexpected CORS authorization for an untrusted origin.' >&2
  exit 1
fi

metadata="$(curl --fail --silent --show-error --cacert "${cert_file}" https://auth.localhost/realms/company/.well-known/openid-configuration)"
jq -e '.code_challenge_methods_supported | index("S256") != null' <<<"${metadata}" >/dev/null

authorization_status="$(curl --silent --show-error --cacert "${cert_file}" --get --output /dev/null --write-out '%{http_code}' \
  https://auth.localhost/realms/company/protocol/openid-connect/auth \
  --data-urlencode 'client_id=webapp' \
  --data-urlencode 'redirect_uri=https://app.localhost/callback' \
  --data-urlencode 'response_type=code' \
  --data-urlencode 'scope=openid docs:read docs:write admin' \
  --data-urlencode 'code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG' \
  --data-urlencode 'code_challenge_method=S256')"
[[ "${authorization_status}" == 200 ]] || {
  printf 'Browser authorization request returned %s instead of the login page.\n' "${authorization_status}" >&2
  exit 1
}
printf '%s\n' 'Web application static and API-boundary acceptance passed.'
