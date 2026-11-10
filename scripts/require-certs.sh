#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cert_file="${repo_root}/infra/certs/localhost.pem"
key_file="${repo_root}/infra/certs/localhost-key.pem"

if [[ ! -s "${cert_file}" || ! -s "${key_file}" ]]; then
  printf '%s\n' 'Local HTTPS certificates are missing. Install mkcert, run make certs, then retry.' >&2
  exit 1
fi

if [[ "$(stat -c '%a' "${key_file}")" != 600 ]]; then
  printf '%s\n' 'The local HTTPS private key must have mode 0600.' >&2
  exit 1
fi
