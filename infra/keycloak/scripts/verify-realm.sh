#!/usr/bin/env bash
set -euo pipefail

config_file=/tmp/kcadm.config
kcadm=/opt/keycloak/bin/kcadm.sh

assert_contains() {
  local value="$1"
  local pattern="$2"
  local description="$3"
  grep -q -- "${pattern}" <<<"${value}" || {
    printf 'Keycloak verification failed: %s.\n' "${description}" >&2
    exit 1
  }
}

client_json() {
  local client_id="$1"
  local listing internal_id
  listing="$("${kcadm}" get clients -r company -q "clientId=${client_id}" --fields id,clientId --config "${config_file}")"
  internal_id="$(sed -n 's/.*"id" : "\([^"]*\)".*/\1/p' <<<"${listing}" | head -n 1)"
  [[ -n "${internal_id}" ]] || { printf 'Keycloak verification failed: missing client %s.\n' "${client_id}" >&2; exit 1; }
  "${kcadm}" get "clients/${internal_id}" -r company --config "${config_file}"
}

"${kcadm}" config credentials \
  --config "${config_file}" \
  --server http://keycloak:8080 \
  --realm master \
  --user "${KC_ADMIN}" \
  --password "${KC_ADMIN_PASSWORD}" >/dev/null

realm_json="$("${kcadm}" get realms/company --config "${config_file}")"
assert_contains "${realm_json}" '"realm" : "company"' 'company realm is missing'
if ! grep -q '"lab.config.revision" : "m5-1"' <<<"${realm_json}"; then
  printf '%s\n' 'Persisted realm revision is stale. Review the realm change, then use the guarded make reset CONFIRM=reset path only with operator approval.' >&2
  exit 1
fi
assert_contains "${realm_json}" '"accessTokenLifespan" : 300' 'access-token lifespan is not 300 seconds'
assert_contains "${realm_json}" '"ssoSessionIdleTimeout" : 1800' 'SSO idle timeout is not 30 minutes'
assert_contains "${realm_json}" '"revokeRefreshToken" : true' 'refresh-token rotation is disabled'
assert_contains "${realm_json}" '"refreshTokenMaxReuse" : 0' 'refresh-token reuse is not zero'
assert_contains "${realm_json}" '"eventsEnabled" : true' 'realm events are disabled'
assert_contains "${realm_json}" '"eventsListeners" : \[ "jboss-logging" \]' 'jboss event logging is not configured'
assert_contains "${realm_json}" '"adminEventsEnabled" : true' 'admin events are disabled'
assert_contains "${realm_json}" '"adminEventsDetailsEnabled" : true' 'admin-event details are disabled'

default_scopes_json="$("${kcadm}" get realms/company/default-default-client-scopes --config "${config_file}")"
assert_contains "${default_scopes_json}" '"name" : "roles"' 'roles is not a realm default client scope'

account_console_json="$(client_json account-console)"
assert_contains "${account_console_json}" '"defaultClientScopes" : \[ "roles" \]' 'account console tokens cannot expose account roles'

webapp_json="$(client_json webapp)"
assert_contains "${webapp_json}" '"publicClient" : true' 'webapp is not public'
assert_contains "${webapp_json}" '"standardFlowEnabled" : true' 'webapp authorization-code flow is disabled'
assert_contains "${webapp_json}" '"directAccessGrantsEnabled" : false' 'webapp direct grants are enabled'
assert_contains "${webapp_json}" '"serviceAccountsEnabled" : false' 'webapp service account is enabled'
assert_contains "${webapp_json}" '"pkce.code.challenge.method" : "S256"' 'webapp does not require PKCE S256'
assert_contains "${webapp_json}" '"https://app.localhost/\*"' 'webapp redirect URI is missing'
for scope in identity-claims docs:read docs:write api-audience; do
  assert_contains "${webapp_json}" "\"${scope}\"" "webapp is missing default scope ${scope}"
done
assert_contains "${webapp_json}" '"admin"' 'webapp is missing optional admin scope'

job_json="$(client_json job)"
assert_contains "${job_json}" '"publicClient" : false' 'job is not confidential'
assert_contains "${job_json}" '"standardFlowEnabled" : false' 'job authorization-code flow is enabled'
assert_contains "${job_json}" '"directAccessGrantsEnabled" : false' 'job direct grants are enabled'
assert_contains "${job_json}" '"serviceAccountsEnabled" : true' 'job service account is disabled'
for scope in identity-claims reports:run api-audience; do
  assert_contains "${job_json}" "\"${scope}\"" "job is missing default scope ${scope}"
done

api_json="$(client_json api)"
assert_contains "${api_json}" '"publicClient" : false' 'API introspection client is not confidential'
assert_contains "${api_json}" '"standardFlowEnabled" : false' 'API authorization-code flow is enabled'
assert_contains "${api_json}" '"directAccessGrantsEnabled" : false' 'API direct grants are enabled'
assert_contains "${api_json}" '"serviceAccountsEnabled" : false' 'API service account is enabled'

test_cli_json="$(client_json test-cli)"
assert_contains "${test_cli_json}" '"publicClient" : true' 'test-cli is not public'
assert_contains "${test_cli_json}" '"standardFlowEnabled" : false' 'test-cli authorization-code flow is enabled'
assert_contains "${test_cli_json}" '"directAccessGrantsEnabled" : true' 'test-cli direct grants are disabled'
assert_contains "${test_cli_json}" '"serviceAccountsEnabled" : false' 'test-cli service account is enabled'

client_scopes_json="$("${kcadm}" get client-scopes -r company --config "${config_file}")"
for scope in roles identity-claims docs:read docs:write admin reports:run api-audience; do
  assert_contains "${client_scopes_json}" "\"name\" : \"${scope}\"" "client scope ${scope} is missing"
done
assert_contains "${client_scopes_json}" '"protocolMapper" : "oidc-usermodel-client-role-mapper"' 'account tokens cannot expose client roles'
assert_contains "${client_scopes_json}" '"protocolMapper" : "oidc-sub-mapper"' 'access tokens do not include the stable subject claim'
assert_contains "${client_scopes_json}" '"claim.name" : "email"' 'tokens do not include the explicit email claim'

ldap_json="$("${kcadm}" get components -r company -q name=openldap --config "${config_file}")"
assert_contains "${ldap_json}" '"providerId" : "ldap"' 'LDAP provider is missing'
assert_contains "${ldap_json}" '"editMode" : \[ "READ_ONLY" \]' 'LDAP provider is not read-only'
assert_contains "${ldap_json}" '"connectionUrl" : \[ "ldap://ldap:1389" \]' 'LDAP connection URL is incorrect'
assert_contains "${ldap_json}" '"usersDn" : \[ "ou=people,dc=iam,dc=localhost" \]' 'LDAP users DN is incorrect'

exec 3<>/dev/tcp/keycloak/9000
printf 'GET /metrics HTTP/1.1\r\nHost: keycloak\r\nConnection: close\r\n\r\n' >&3
metrics_response="$(cat <&3)"
exec 3<&-
exec 3>&-
assert_contains "${metrics_response}" '200 OK' 'management metrics endpoint is unavailable'
assert_contains "${metrics_response}" 'keycloak_' 'management metrics contain no Keycloak metrics'

if [[ "${VERIFY_EVENTS:-false}" == true ]]; then
  events_json="$("${kcadm}" get events -r company -q type=LOGIN --config "${config_file}")"
  assert_contains "${events_json}" '"type" : "LOGIN"' 'no stored login event is observable'
  error_events_json="$("${kcadm}" get events -r company -q type=CLIENT_LOGIN_ERROR --config "${config_file}")"
  assert_contains "${error_events_json}" '"error" : "invalid_client_credentials"' 'invalid-client login errors are not observable'
  "${kcadm}" update realms/company -s 'displayName=IAM Access Revocation Lab' --config "${config_file}" >/dev/null
  admin_events_json="$("${kcadm}" get admin-events -r company --config "${config_file}")"
  assert_contains "${admin_events_json}" '"operationType" : "UPDATE"' 'admin update events are not observable'
fi
printf '%s\n' 'Keycloak declarative realm verification passed.'
