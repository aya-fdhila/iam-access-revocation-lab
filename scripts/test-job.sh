#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_root}"

compose=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)
npm --prefix services/job run check
npm --prefix services/job run build >/dev/null

job_id="$(${compose[@]} ps --quiet job)"
[[ -n "${job_id}" ]] || { printf '%s\n' 'The job container is not running. Run make up first.' >&2; exit 2; }

job_user="$(docker inspect --format '{{.Config.User}}' "${job_id}")"
[[ "${job_user}" == "1000:1000" ]] || { printf 'Unexpected job container user: %s\n' "${job_user}" >&2; exit 1; }
job_health="$(docker inspect --format '{{.State.Health.Status}}' "${job_id}")"
[[ "${job_health}" == "healthy" ]] || { printf 'Unexpected job health: %s\n' "${job_health}" >&2; exit 1; }
project_name="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "${job_id}")"
mapfile -t job_networks < <(docker inspect "${job_id}" | jq -r '.[0].NetworkSettings.Networks | keys[]')
[[ "${#job_networks[@]}" -eq 1 && "${job_networks[0]}" == "${project_name}_workload" ]] || {
  printf '%s\n' 'The scheduled job must attach only to the internal workload network.' >&2
  exit 1
}

logs="$(${compose[@]} logs --no-color job)"
grep -q '"event":"scheduled_report.completed"' <<<"${logs}"
grep -q '"status":200' <<<"${logs}"

job_secret="$(awk -F= '$1 == "JOB_CLIENT_SECRET" {sub(/^[^=]*=/, ""); print; exit}' .env)"
if [[ -n "${job_secret}" ]] && grep -Fq -- "${job_secret}" <<<"${logs}"; then
  printf '%s\n' 'The job client secret appeared in logs.' >&2
  exit 1
fi
if grep -Eq 'Bearer [A-Za-z0-9._-]+' <<<"${logs}"; then
  printf '%s\n' 'A bearer token appeared in job logs.' >&2
  exit 1
fi
printf '%s\n' 'Scheduled job acceptance passed.'
