# Scheduled report job

This non-interactive workload uses OAuth Client Credentials, caches one access
token in process memory until shortly before expiry, and calls the internal
reports endpoint. JSON logs include event, status, duration, and cache reuse—never
credentials or token strings.

```bash
npm install
npm run check
```
