# Security console

The React/Vite console is a public OAuth client. It uses Authorization Code with
PKCE S256, keeps processed ID and access tokens only in JavaScript memory, and
stores only the short-lived authorization transaction in `sessionStorage` while
the browser is away at Keycloak.

```bash
npm install
npm run dev
npm run check
npm run browser:smoke
```

The supported deployed URL is `https://app.localhost`. A page reload deliberately
clears the authenticated UI session and requires a new authorization redirect.
While the page remains open, `oidc-client-ts` renews the session automatically
with a rotating refresh token held only in memory. Logout attempts token
revocation before clearing local state and redirecting to Keycloak logout.

This browser-only token handling is appropriate for the lab because observing
token expiry and revocation is part of the exercise. A production application
should normally use a backend-for-frontend (BFF) so the browser holds an
HTTP-only session cookie instead of OAuth tokens.

The browser smoke requires the stack to be running, `LDAP_USER_PASSWORD` in the
environment, Google Chrome at `/usr/bin/google-chrome` (or `CHROME_BIN`), and the
local `mkcert` CA trusted by Chrome. It deliberately waits for the realm's real
silent-renewal threshold and never enables `ignoreHTTPSErrors`.
