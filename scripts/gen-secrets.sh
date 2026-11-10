#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
env_file="${1:-${repo_root}/.env}"
template_file="${repo_root}/.env.example"

secret_keys=(
  LDAP_ADMIN_PASSWORD
  LDAP_BIND_PASSWORD
  LDAP_USER_PASSWORD
  KC_ADMIN_PASSWORD
  KC_DB_PASSWORD
  JOB_CLIENT_SECRET
  API_CLIENT_SECRET
  NOT_BEFORE_REDIS_PASSWORD
  OFFBOARDING_API_SECRET
  BENCHMARK_API_SECRET
  GRAFANA_ADMIN_PASSWORD
)

if [[ ! -f "${template_file}" ]]; then
  printf 'Missing template: %s\n' "${template_file}" >&2
  exit 1
fi

umask 077
if [[ ! -e "${env_file}" ]]; then
  install -m 600 "${template_file}" "${env_file}"
elif [[ ! -f "${env_file}" ]]; then
  printf 'Environment path is not a regular file: %s\n' "${env_file}" >&2
  exit 1
fi
chmod 600 "${env_file}"

replace_value() {
  local key="$1"
  local value="$2"
  local temp_file
  temp_file="$(mktemp "${env_file}.tmp.XXXXXX")"
  awk -v wanted_key="${key}" -v replacement="${value}" '
    BEGIN { found = 0 }
    index($0, wanted_key "=") == 1 {
      print wanted_key "=" replacement
      found = 1
      next
    }
    { print }
    END {
      if (!found) {
        print wanted_key "=" replacement
      }
    }
  ' "${env_file}" > "${temp_file}"
  chmod 600 "${temp_file}"
  mv -f -- "${temp_file}" "${env_file}"
}

for key in "${secret_keys[@]}"; do
  current_value="$(awk -F= -v wanted_key="${key}" '$1 == wanted_key {sub(/^[^=]*=/, ""); print; exit}' "${env_file}")"
  if [[ -z "${current_value}" || "${current_value}" == replace-with-generated-secret ]]; then
    replace_value "${key}" "$(openssl rand -hex 32)"
  fi
done

printf 'Local secrets are ready in %s (values were not printed).\n' "${env_file}"
