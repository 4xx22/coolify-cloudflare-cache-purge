# Security Policy

## Reporting a vulnerability

Please do not disclose security vulnerabilities in a public issue.

Use GitHub's **Security** tab to submit a private vulnerability report to the
repository maintainers. Include reproduction steps, the possible impact, and
any suggested remediation.

## Operational security

- Keep `CLOUDFLARE_API_TOKEN` and `WEBHOOK_SECRET` in Cloudflare Worker secrets.
- Scope the API token to one zone and grant only `Zone / Cache Purge`.
- Use a unique webhook secret of at least 32 random characters.
- Rotate both secrets immediately if the Coolify webhook URL is exposed.
- Consider `ALLOWED_APPLICATION_UUIDS` an additional safeguard, not a
  replacement for webhook authentication.
