# Grafana

Grafana is provisioned entirely from the files below and exposed through Traefik at `https://grafana.localhost`. Anonymous access is viewer-only. The administrator password is generated into the ignored `.env`; it is never committed.

Versioned alert rules are available under **Alerting > Alert rules** after Grafana starts. They monitor IAM target availability, authentication failures, and API p95 latency. A provisioned email contact point can send firing and recovery notifications when SMTP is enabled through private `.env` values.
