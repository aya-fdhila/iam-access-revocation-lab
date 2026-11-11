# Grafana Provisioning

The Prometheus datasource, dashboard provider, alert rules, contact point, and notification policy are versioned here. Grafana loads them automatically on startup, so a clean clone requires no UI setup.

The provisioned alerts are visible under **Alerting > Alert rules**:

- IAM target unavailable: an API or Keycloak scrape target is down for one minute.
- High authentication failure rate: rejected or unavailable authentications exceed 20% for one minute.
- High API p95 latency: p95 response time exceeds 250 ms for two minutes.

The notification policy routes firing and resolved alerts to the provisioned email contact point. Set `GRAFANA_ALERT_EMAIL` and the `GRAFANA_SMTP_*` values in the ignored `.env`; for Gmail, use an application password rather than the account password. SMTP remains disabled by default until those private values are ready.
