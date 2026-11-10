#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_root}"

cert_file="${repo_root}/infra/certs/localhost.pem"
[[ -f "${cert_file}" ]] || { printf '%s\n' 'Missing local certificate. Run make certs first.' >&2; exit 2; }

compose=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)
prometheus_id="$("${compose[@]}" ps --quiet prometheus)"
grafana_id="$("${compose[@]}" ps --quiet grafana)"
[[ -n "${prometheus_id}" && -n "${grafana_id}" ]] || {
  printf '%s\n' 'Prometheus and Grafana must be running. Run make up first.' >&2
  exit 2
}

project_name="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "${prometheus_id}")"
mapfile -t prometheus_networks < <(docker inspect "${prometheus_id}" | jq -r '.[0].NetworkSettings.Networks | keys[]')
[[ "${#prometheus_networks[@]}" -eq 1 && "${prometheus_networks[0]}" == "${project_name}_observability" ]] || {
  printf '%s\n' 'Prometheus must attach only to the private observability network.' >&2
  exit 1
}
[[ -z "$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${prometheus_id}" | jq -r 'to_entries[] | select(.value != null) | .key')" ]] || {
  printf '%s\n' 'Prometheus must not publish a host port.' >&2
  exit 1
}

grafana_health="$(curl --fail --silent --show-error --cacert "${cert_file}" https://grafana.localhost/api/health)"
jq -e '.database == "ok"' <<<"${grafana_health}" >/dev/null

datasource="$(curl --fail --silent --show-error --cacert "${cert_file}" https://grafana.localhost/api/datasources/uid/prometheus)"
jq -e '.uid == "prometheus" and .access == "proxy" and .url == "http://prometheus:9090"' <<<"${datasource}" >/dev/null

dashboard="$(curl --fail --silent --show-error --cacert "${cert_file}" https://grafana.localhost/api/dashboards/uid/iam-access-revocation)"
jq -e '
  .dashboard.editable == false and
  ([.dashboard.panels[].title] | sort) == ([
    "Authentication decisions",
    "Healthy scrape targets",
    "Introspection cache behavior",
    "Identity-provider calls per request",
    "Measured access rejection delay from T1",
    "Request and authentication p95",
    "Request rate and outcomes"
  ] | sort)
' <<<"${dashboard}" >/dev/null

headers="$(curl --fail --silent --show-error --dump-header - --output /dev/null --cacert "${cert_file}" https://grafana.localhost/)"
grep -qi '^strict-transport-security:' <<<"${headers}"
grep -qi '^x-content-type-options: nosniff' <<<"${headers}"

prometheus_proxy="https://grafana.localhost/api/datasources/proxy/uid/prometheus"
query() {
  curl --fail --silent --show-error --cacert "${cert_file}" --get \
    "${prometheus_proxy}/api/v1/query" --data-urlencode "query=$1"
}

required_queries=(
  'sum(iam_api_http_request_duration_seconds_count)'
  'sum(iam_api_authentication_results_total)'
  'sum(iam_api_keycloak_calls_total)'
  'sum(iam_api_jwks_refreshes_total)'
  'sum(iam_api_introspection_cache_total)'
  'count(iam_offboarding_observed_delay_seconds)'
)

for attempt in {1..20}; do
  ready=true
  for expression in "${required_queries[@]}"; do
    response="$(query "${expression}")"
    if ! jq -e '.status == "success" and (.data.result | length) > 0 and (.data.result[0].value[1] | tonumber) > 0' <<<"${response}" >/dev/null; then
      ready=false
      break
    fi
  done
  [[ "${ready}" == true ]] && break
  sleep 2
done
[[ "${ready}" == true ]] || { printf '%s\n' 'Required dashboard metrics did not populate.' >&2; exit 1; }

targets="$(curl --fail --silent --show-error --cacert "${cert_file}" "${prometheus_proxy}/api/v1/targets")"
jq -e '
  .status == "success" and
  ([.data.activeTargets[] | select(.health == "up")] | length) >= 5 and
  ([.data.activeTargets[] | select(.health != "up")] | length) == 0
' <<<"${targets}" >/dev/null

series="$(curl --fail --silent --show-error --cacert "${cert_file}" --get \
  "${prometheus_proxy}/api/v1/series" --data-urlencode 'match[]={__name__=~"iam_.*"}')"
jq -e '.status == "success" and (.data | length) > 0' <<<"${series}" >/dev/null
if jq -r '.data[] | to_entries[] | "\(.key)=\(.value)"' <<<"${series}" | \
  grep -Eqi '(^|=)(username|subject|email|token)(=|$)|=(aya|yassmine|ali|marwen|marwa)([[:space:]]|$)'; then
  printf '%s\n' 'Identity data appeared in a Prometheus metric label.' >&2
  exit 1
fi

while IFS='=' read -r key secret; do
  [[ "${key}" == *_PASSWORD || "${key}" == *_SECRET ]] || continue
  [[ -n "${secret}" && "${secret}" != replace-with-generated-secret ]] || continue
  if grep -Fq -- "${secret}" <<<"${series}${dashboard}${datasource}${targets}"; then
    printf '%s\n' 'A generated secret appeared in observability output.' >&2
    exit 1
  fi
done < .env

"${compose[@]}" exec -T prometheus promtool check config /etc/prometheus/prometheus.yml >/dev/null
"${compose[@]}" exec -T prometheus promtool check rules /etc/prometheus/offboarding.rules.yml >/dev/null

printf '%s\n' 'Observability acceptance passed: private healthy targets, bounded metrics, and provisioned Grafana dashboard.'
