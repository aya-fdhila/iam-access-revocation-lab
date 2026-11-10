# Traefik

`traefik.yml` defines the HTTPS and internal health entry points, JSON logs, file-only configuration provider, disabled dashboard/telemetry, and access-log header redaction. `dynamic.yml` loads the ignored local certificate, requires TLS 1.2 or newer, and forwards to Keycloak without a Docker socket.

`auth.localhost` routes only `/realms/` and `/resources/`; it cannot expose `/admin/`. `admin-auth.localhost` is the separate administration hostname. Both use port 443 on loopback.
