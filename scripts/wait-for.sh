#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage:\n  %s http <url> [timeout-seconds]\n  %s tcp <host> <port> [timeout-seconds]\n' "$0" "$0" >&2
  exit 2
}

mode="${1:-}"
deadline=0

case "${mode}" in
  http)
    [[ $# -ge 2 && $# -le 3 ]] || usage
    target="$2"
    timeout_seconds="${3:-60}"
    command -v curl >/dev/null 2>&1 || { printf '%s\n' 'curl is required for HTTP readiness checks.' >&2; exit 1; }
    ;;
  tcp)
    [[ $# -ge 3 && $# -le 4 ]] || usage
    host="$2"
    port="$3"
    timeout_seconds="${4:-60}"
    ;;
  *) usage ;;
esac

[[ "${timeout_seconds}" =~ ^[1-9][0-9]*$ ]] || { printf '%s\n' 'Timeout must be a positive integer.' >&2; exit 2; }
deadline=$((SECONDS + timeout_seconds))

while (( SECONDS < deadline )); do
  if [[ "${mode}" == http ]]; then
    if curl --fail --silent --show-error --max-time 2 --output /dev/null "${target}" 2>/dev/null; then
      printf 'Ready: %s\n' "${target}"
      exit 0
    fi
  elif (: > "/dev/tcp/${host}/${port}") >/dev/null 2>&1; then
    printf 'Ready: %s:%s\n' "${host}" "${port}"
    exit 0
  fi
  sleep 1
done

if [[ "${mode}" == http ]]; then
  printf 'Timed out waiting for %s after %s seconds.\n' "${target}" "${timeout_seconds}" >&2
else
  printf 'Timed out waiting for %s:%s after %s seconds.\n' "${host}" "${port}" "${timeout_seconds}" >&2
fi
exit 1
