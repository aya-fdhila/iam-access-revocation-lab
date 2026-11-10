#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == -install ]]; then
  exit 0
fi

cert_file=""
key_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -cert-file)
      cert_file="${2:-}"
      shift 2
      ;;
    -key-file)
      key_file="${2:-}"
      shift 2
      ;;
    *) shift ;;
  esac
done

[[ -n "${cert_file}" && -n "${key_file}" ]] || { printf '%s\n' 'Fake mkcert requires certificate and key output paths.' >&2; exit 2; }
printf '%s\n' 'test certificate — not valid cryptographic material' > "${cert_file}"
printf '%s\n' 'test private key — not valid cryptographic material' > "${key_file}"
