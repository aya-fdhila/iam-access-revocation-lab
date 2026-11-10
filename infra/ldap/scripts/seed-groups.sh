#!/usr/bin/env bash
set -euo pipefail

marker=/var/lib/ldap/.seed-v1-complete
if [[ -f "${marker}" ]]; then
  printf '%s\n' 'LDAP seed marker exists; persistent memberships were not changed.'
  exit 0
fi

if [[ -z "${LDAP_ADMIN_PASSWORD:-}" || "${LDAP_ADMIN_PASSWORD}" == replace-with-generated-secret ]]; then
  printf '%s\n' 'LDAP_ADMIN_PASSWORD is not generated. Run make secrets first.' >&2
  exit 1
fi

password_file="$(mktemp /tmp/ldap-admin-password.XXXXXX)"
change_file="$(mktemp /tmp/ldap-groups.XXXXXX.ldif)"
trap 'rm -f -- "${password_file}" "${change_file}"' EXIT
chmod 600 "${password_file}"
printf '%s' "${LDAP_ADMIN_PASSWORD}" > "${password_file}"

cat > "${change_file}" <<'LDIF'
dn: cn=employees,ou=groups,dc=iam,dc=localhost
changetype: modify
replace: member
member: uid=ali,ou=people,dc=iam,dc=localhost
member: uid=marwen,ou=people,dc=iam,dc=localhost
member: uid=marwa,ou=people,dc=iam,dc=localhost

dn: cn=managers,ou=groups,dc=iam,dc=localhost
changetype: modify
replace: member
member: uid=marwen,ou=people,dc=iam,dc=localhost

dn: cn=admins,ou=groups,dc=iam,dc=localhost
changetype: modify
replace: member
member: uid=aya,ou=people,dc=iam,dc=localhost
member: uid=yassmine,ou=people,dc=iam,dc=localhost
LDIF

ldapmodify -x -H ldap://ldap:1389 \
  -D 'cn=admin,dc=iam,dc=localhost' \
  -y "${password_file}" \
  -f "${change_file}"

touch "${marker}"
printf '%s\n' 'Applied fresh-volume LDAP group memberships.'
