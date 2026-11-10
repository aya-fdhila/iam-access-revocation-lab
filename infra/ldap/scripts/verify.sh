#!/usr/bin/env bash
set -euo pipefail

ldap_uri=ldap://127.0.0.1:1389
base_dn=dc=iam,dc=localhost
admin_dn=cn=admin,dc=iam,dc=localhost
bind_dn=uid=keycloak-bind,ou=service-accounts,dc=iam,dc=localhost
marwa_dn=uid=marwa,ou=people,dc=iam,dc=localhost

temp_dir="$(mktemp -d /tmp/ldap-verify.XXXXXX)"
lockout_cleanup=false

cleanup() {
  if [[ "${lockout_cleanup}" == true ]]; then
    ldapmodify -x -e relax -H "${ldap_uri}" -D "${admin_dn}" -y "${temp_dir}/admin" \
      -f "${temp_dir}/unlock.ldif" >/dev/null 2>&1 || true
  fi
  rm -rf -- "${temp_dir}"
}
trap cleanup EXIT

write_password() {
  local path="$1"
  local value="$2"
  printf '%s' "${value}" > "${path}"
  chmod 600 "${path}"
}

write_password "${temp_dir}/admin" "${LDAP_ADMIN_PASSWORD}"
write_password "${temp_dir}/bind" "${LDAP_BIND_PASSWORD}"
write_password "${temp_dir}/user" "${LDAP_USER_PASSWORD}"
write_password "${temp_dir}/wrong" 'deliberately-wrong-password'

if [[ "${1:-verify}" == entry-uuid ]]; then
  username="${2:-marwa}"
  ldapsearch -LLL -x -H "${ldap_uri}" -D "${bind_dn}" -y "${temp_dir}/bind" \
    -b "uid=${username},ou=people,${base_dn}" -s base '(objectClass=*)' entryUUID \
    | awk '/^entryUUID: / { print $2 }'
  exit 0
fi

assert_user() {
  local username="$1"
  local common_name="$2"
  shift 2
  local entry_file="${temp_dir}/${username}.ldif"
  local expected_group
  local -a actual_groups

  ldapsearch -LLL -x -H "${ldap_uri}" -D "${bind_dn}" -y "${temp_dir}/bind" \
    -b "uid=${username},ou=people,${base_dn}" -s base '(objectClass=inetOrgPerson)' \
    uid cn memberOf > "${entry_file}"

  grep -Fqx "uid: ${username}" "${entry_file}" || {
    printf 'Missing expected LDAP user: %s\n' "${username}" >&2
    exit 1
  }
  grep -Fqx "cn: ${common_name}" "${entry_file}" || {
    printf 'Unexpected common name for LDAP user %s.\n' "${username}" >&2
    exit 1
  }

  mapfile -t actual_groups < <(awk '/^memberOf: / { sub(/^memberOf: /, ""); print }' "${entry_file}")
  [[ "${#actual_groups[@]}" -eq "$#" ]] || {
    printf 'Unexpected group count for LDAP user %s: expected %s, got %s.\n' \
      "${username}" "$#" "${#actual_groups[@]}" >&2
    exit 1
  }
  for expected_group in "$@"; do
    printf '%s\n' "${actual_groups[@]}" | grep -Fqx "${expected_group}" || {
      printf 'Missing expected group for LDAP user %s: %s\n' "${username}" "${expected_group}" >&2
      exit 1
    }
  done
}

employees_group="cn=employees,ou=groups,${base_dn}"
managers_group="cn=managers,ou=groups,${base_dn}"
admins_group="cn=admins,ou=groups,${base_dn}"

assert_user aya 'Aya Fdhila' "${admins_group}"
assert_user yassmine 'Yassmine Ghali' "${admins_group}"
assert_user marwen 'Marwen Ben Salem' "${employees_group}" "${managers_group}"
assert_user ali 'Ali Mansouri' "${employees_group}"
assert_user marwa 'Marwa Trabelsi' "${employees_group}"

ldapsearch -LLL -x -H "${ldap_uri}" -D "${bind_dn}" -y "${temp_dir}/bind" \
  -b "${marwa_dn}" -s base '(objectClass=*)' \
  userPassword pwdFailureTime pwdAccountLockedTime > "${temp_dir}/sensitive.ldif"
if grep -Eq '^(userPassword|pwdFailureTime|pwdAccountLockedTime):' "${temp_dir}/sensitive.ldif"; then
  printf '%s\n' 'The read-only bind identity exposed a protected authentication attribute.' >&2
  exit 1
fi

ldapsearch -LLL -x -H "${ldap_uri}" -b "ou=people,${base_dn}" \
  '(objectClass=inetOrgPerson)' uid > "${temp_dir}/anonymous.ldif" 2>&1 || true
if grep -Eq '^(dn|uid):' "${temp_dir}/anonymous.ldif"; then
  printf '%s\n' 'Anonymous LDAP access enumerated a person entry.' >&2
  exit 1
fi

cat > "${temp_dir}/forbidden-change.ldif" <<'LDIF'
dn: uid=ali,ou=people,dc=iam,dc=localhost
changetype: modify
replace: description
description: this write must be refused
LDIF

set +e
ldapmodify -x -H "${ldap_uri}" -D "${bind_dn}" -y "${temp_dir}/bind" \
  -f "${temp_dir}/forbidden-change.ldif" > "${temp_dir}/forbidden.out" 2>&1
readonly_write_status=$?
set -e
[[ "${readonly_write_status}" -eq 50 ]] || {
  printf 'Expected read-only bind mutation to fail with LDAP 50, got %s.\n' "${readonly_write_status}" >&2
  cat "${temp_dir}/forbidden.out" >&2
  exit 1
}

ldapsearch -LLL -x -H "${ldap_uri}" -D "${marwa_dn}" -y "${temp_dir}/user" \
  -b "${marwa_dn}" -s base '(objectClass=*)' uid >/dev/null

ldapsearch -LLL -x -H "${ldap_uri}" -D "${marwa_dn}" -y "${temp_dir}/user" \
  -b "uid=ali,ou=people,${base_dn}" -s base '(objectClass=*)' uid \
  > "${temp_dir}/cross-user.ldif" 2>&1 || true
if grep -Eq '^(dn|uid):' "${temp_dir}/cross-user.ldif"; then
  printf '%s\n' 'Marwa read another user entry despite the self-only ACL.' >&2
  exit 1
fi

cat > "${temp_dir}/unlock.ldif" <<LDIF
dn: ${marwa_dn}
changetype: modify
delete: pwdAccountLockedTime
-
delete: pwdFailureTime
LDIF
lockout_cleanup=true

for _ in 1 2 3; do
  ldapsearch -LLL -x -H "${ldap_uri}" -D "${marwa_dn}" -y "${temp_dir}/wrong" \
    -b "${marwa_dn}" -s base '(objectClass=*)' uid >/dev/null 2>&1 || true
done

set +e
ldapsearch -LLL -x -H "${ldap_uri}" -D "${marwa_dn}" -y "${temp_dir}/user" \
  -b "${marwa_dn}" -s base '(objectClass=*)' uid > "${temp_dir}/locked.out" 2>&1
locked_bind_status=$?
set -e
[[ "${locked_bind_status}" -eq 49 ]] || {
  printf 'Expected locked Marwa bind to fail with LDAP 49, got %s.\n' "${locked_bind_status}" >&2
  exit 1
}

ldapmodify -x -e relax -H "${ldap_uri}" -D "${admin_dn}" -y "${temp_dir}/admin" \
  -f "${temp_dir}/unlock.ldif" >/dev/null
lockout_cleanup=false

ldapsearch -LLL -x -H "${ldap_uri}" -D "${marwa_dn}" -y "${temp_dir}/user" \
  -b "${marwa_dn}" -s base '(objectClass=*)' uid >/dev/null

printf '%s\n' 'LDAP authorization, membership, and lockout checks passed.'
