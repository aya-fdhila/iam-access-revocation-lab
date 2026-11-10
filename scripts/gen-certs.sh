#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cert_dir="${CERT_DIR:-${repo_root}/infra/certs}"
cert_file="${cert_dir}/localhost.pem"
key_file="${cert_dir}/localhost-key.pem"
mkcert_bin="${MKCERT_BIN:-mkcert}"

if ! command -v "${mkcert_bin}" >/dev/null 2>&1; then
  printf '%s\n' 'mkcert is required. Install mkcert and the NSS tools for your OS, then rerun make certs.' >&2
  exit 1
fi

if [[ -f "${cert_file}" && -f "${key_file}" ]]; then
  printf 'Certificates already exist in %s; nothing changed.\n' "${cert_dir}"
  exit 0
fi

if [[ -e "${cert_file}" || -e "${key_file}" ]]; then
  printf '%s\n' 'Certificate state is incomplete. Move the remaining file aside, then rerun make certs.' >&2
  exit 1
fi

mkdir -p "${cert_dir}"
umask 077
"${mkcert_bin}" -install
"${mkcert_bin}" \
  -cert-file "${cert_file}" \
  -key-file "${key_file}" \
  auth.localhost \
  admin-auth.localhost \
  app.localhost \
  api.localhost \
  grafana.localhost

chmod 600 "${key_file}"
printf 'Local HTTPS certificate created at %s.\n' "${cert_file}"
