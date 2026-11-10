#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/.." && pwd)"
cd "${repo_root}"

compose=(docker compose -f docker-compose.yml -f docker-compose.dev.yml)

make up

before_uuid="$("${compose[@]}" exec -T ldap /config/scripts/verify.sh entry-uuid marwa)"
[[ -n "${before_uuid}" ]] || { printf '%s\n' 'Marwa entryUUID was empty before restart.' >&2; exit 1; }

"${compose[@]}" exec -T ldap /config/scripts/verify.sh
"${compose[@]}" restart ldap >/dev/null

ready=false
for _ in $(seq 1 30); do
  if "${compose[@]}" exec -T ldap ldapsearch -LLL -x \
    -H ldap://127.0.0.1:1389 -b '' -s base '(objectClass=*)' namingContexts >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "${ready}" == true ]] || { printf '%s\n' 'LDAP did not become ready after restart.' >&2; exit 1; }

after_uuid="$("${compose[@]}" exec -T ldap /config/scripts/verify.sh entry-uuid marwa)"
[[ "${before_uuid}" == "${after_uuid}" ]] || {
  printf 'Marwa entryUUID changed across restart: %s -> %s\n' "${before_uuid}" "${after_uuid}" >&2
  exit 1
}

"${compose[@]}" exec -T ldap /config/scripts/verify.sh
printf 'LDAP integration checks passed; Marwa entryUUID remained %s.\n' "${after_uuid}"
