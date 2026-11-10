#!/usr/bin/env bash
set -euo pipefail

config_dir=/etc/ldap/slapd.d
data_dir=/var/lib/ldap
database_marker="${data_dir}/.database-v1-complete"
runtime_dir=/run/slapd
config_file=/config/config/slapd.ldif
seed_template=/config/ldif/seed.ldif.template

require_secret() {
  local name="$1"
  local value="${!name:-}"
  if [[ -z "${value}" || "${value}" == replace-with-generated-secret ]]; then
    printf 'Missing generated secret: %s. Run make secrets first.\n' "${name}" >&2
    exit 1
  fi
}

require_secret LDAP_ADMIN_PASSWORD
require_secret LDAP_BIND_PASSWORD
require_secret LDAP_USER_PASSWORD

rm -rf -- "${config_dir:?}"/*
mkdir -p "${config_dir}" "${runtime_dir}"
slapadd -n 0 -F "${config_dir}" -l "${config_file}"

if [[ -f "${data_dir}/data.mdb" && -f "${database_marker}" ]]; then
  printf '%s\n' 'Using existing LDAP database; seed data was not reapplied.'
elif [[ -f "${data_dir}/data.mdb" || -f "${database_marker}" ]]; then
  printf '%s\n' 'LDAP database initialization is incomplete. Preserve it for diagnosis or run the explicitly approved destructive reset.' >&2
  exit 1
else
  admin_hash="$(slappasswd -s "${LDAP_ADMIN_PASSWORD}")"
  bind_hash="$(slappasswd -s "${LDAP_BIND_PASSWORD}")"
  user_hash="$(slappasswd -s "${LDAP_USER_PASSWORD}")"
  seed_file="$(mktemp /tmp/ldap-seed.XXXXXX.ldif)"
  trap 'rm -f -- "${seed_file:-}"' EXIT

  awk \
    -v admin_hash="${admin_hash}" \
    -v bind_hash="${bind_hash}" \
    -v user_hash="${user_hash}" '
      { gsub(/\{\{LDAP_ADMIN_PASSWORD_HASH\}\}/, admin_hash) }
      { gsub(/\{\{LDAP_BIND_PASSWORD_HASH\}\}/, bind_hash) }
      { gsub(/\{\{LDAP_USER_PASSWORD_HASH\}\}/, user_hash) }
      { print }
    ' "${seed_template}" > "${seed_file}"

  slapadd -n 1 -F "${config_dir}" -l "${seed_file}"
  slapindex -n 1 -F "${config_dir}"
  rm -f -- "${seed_file}"
  trap - EXIT
  touch "${database_marker}"
  printf '%s\n' 'Initialized fresh LDAP database.'
fi

exec slapd -d stats -F "${config_dir}" \
  -h 'ldap://0.0.0.0:1389/ ldapi://%2Frun%2Fslapd%2Fldapi'
