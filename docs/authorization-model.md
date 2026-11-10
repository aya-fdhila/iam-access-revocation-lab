# Authorization Model

## Policy layers

The resource server evaluates three independent policy layers after token authentication:

1. **Scope** describes what the OAuth client was granted permission to request.
2. **Realm role** describes the person's organizational role, derived from LDAP group membership.
3. **Ownership or service identity** constrains access to a resource or machine-only operation.

Passing one layer never bypasses another. For example, an administrator role does not manufacture a missing OAuth scope.

## Identities and claims

| Profile | LDAP groups / identity | Expected roles | Expected scopes |
|---|---|---|---|
| Anonymous | None | None | None |
| Aya Fdhila (`aya`) | `admins` | `admins` | `admin` when explicitly requested; document scopes if configured |
| Ali Mansouri (`ali`) | `employees` | `employees` | `docs:read docs:write` |
| Yassmine Ghali (`yassmine`) | `admins` | `admins` | `admin` when explicitly requested; document scopes if configured |
| Marwen Ben Salem (`marwen`) | `employees`, `managers` | `employees managers` | `docs:read docs:write` |
| Job | `job` service account | Service-account roles only | `reports:run` |
| Marwa Trabelsi (`marwa`) | `employees` before offboarding | `employees` before a new token reflects removal | `docs:read docs:write` |

Required access-token claims:

- `iss`: exact `company` realm issuer;
- `aud`: contains `api`;
- `exp`, `iat`, and when present `nbf`;
- `scope`: space-delimited granted scopes;
- `preferred_username` for user ownership;
- `realm_access.roles` for LDAP-derived realm roles;
- client identity claims sufficient to distinguish the `job` service account.

## Route policy

| Route | Scope | Accepted role | Additional rule |
|---|---|---|---|
| `GET /health` | None | None | Public; returns no sensitive dependency detail |
| `GET /me` | None | Any authenticated identity | Returns a safe subset of claims |
| `GET /documents` | `docs:read` | employee, manager, or admin | Employees see only their own; managers/admins see all |
| `GET /documents/:id` | `docs:read` | employee, manager, or admin | Owner, manager, or admin |
| `POST /documents` | `docs:write` | employee, manager, or admin | Owner is forced to `preferred_username` |
| `DELETE /documents/:id` | `docs:write` | employee, manager, or admin | Owner or admin |
| `GET /admin/users` | `admin` | admin | No role-only bypass |
| `POST /reports/run` | `reports:run` | None | Must be the `job` service account |

Seed documents are deterministic: document 1 belongs to Aya, 2 to Ali, and 3 to Marwa.

## Authentication versus authorization errors

### 401 Unauthorized

Use 401 when the API cannot establish a valid authenticated principal:

- missing bearer token;
- malformed token;
- invalid or tampered signature;
- wrong issuer or audience;
- expired or not-yet-valid token;
- inactive introspection response;
- token issued before the user's enforced not-before timestamp.

The response includes an appropriate `WWW-Authenticate: Bearer` challenge without revealing token contents or sensitive verification detail.

### 403 Forbidden

Use 403 after authentication succeeds but policy denies the operation:

- missing scope;
- missing accepted role;
- wrong service-account client;
- ownership rule fails.

The response may identify the missing policy category in a safe, stable error code, but it must not disclose another user's document contents.

## Expected behavior matrix

This compact matrix explains the principal happy and refusal paths. The canonical automated matrix is the complete cross-product of seven profiles, eight public API operations, and all three validation modes (168 policy checks), plus three negative signed-token cases in each mode (9 checks). It records exact REST outcomes, including `201` for document creation and `204` for successful deletion, for 177 checks in total.

| Profile | Own document | Other document | Create | Delete own | Delete other | Admin users | Run report |
|---|---:|---:|---:|---:|---:|---:|---:|
| Anonymous | 401 | 401 | 401 | 401 | 401 | 401 | 401 |
| Ali / Marwa before exit | 200 | 403 | 200 | 200 | 403 | 403 | 403 |
| Marwen (manager) | 200 | 200 | 200 | 200 | 403 | 403 | 403 |
| Aya / Yassmine (admin + requested admin scope) | 200 | 200 | Depends on docs scopes | Depends on docs scopes | Depends on docs scopes | 200 | 403 |
| Job service account | 403 | 403 | 403 | 403 | 403 | 403 | 200 |

The exact Aya and Yassmine document results remain scope-driven: roles cannot replace `docs:read` or `docs:write`. The configured default document scopes let both administrators exercise those routes, while the `admin` scope is requested explicitly for `GET /admin/users`.

## Negative test catalog

Every validation mode must refuse:

- an expired token;
- a token with `aud` not containing `api`;
- a token with a modified payload and unchanged signature;
- an inactive token in introspection modes;
- a token predating enforced per-user not-before in local mode;
- a valid token lacking the route's scope;
- a valid token lacking the route's role;
- a valid user token presented to the job-only route;
- a valid employee token accessing another employee's document.

The same authorization policy functions must be used after local or introspection authentication so that mode comparisons measure token validation—not policy drift.
