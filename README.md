# Coolify Cloudflare Cache Purge

[![CI](https://github.com/4xx22/coolify-cloudflare-cache-purge/actions/workflows/ci.yml/badge.svg)](https://github.com/4xx22/coolify-cloudflare-cache-purge/actions/workflows/ci.yml)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/4xx22/coolify-cloudflare-cache-purge)

A small, secure Cloudflare Worker that receives
[Coolify webhook notifications](https://coolify.io/docs/knowledge-base/notifications)
and purges an application's Cloudflare cache after a successful deployment.

By default, only the hostnames included in Coolify's `deployment_success`
payload are purged. The Worker ignores failed deployments, test notifications,
and every other Coolify event.

## How it works

1. Coolify sends a `POST` request after a successful application deployment.
2. The Worker authenticates the request with a shared secret.
3. It validates the `deployment_success` payload and, if configured, the
   application's UUID.
4. It calls Cloudflare's zone cache purge API for the deployed hostname(s).
5. It returns a structured JSON result to Coolify.

The default `hostname` mode is available on every Cloudflare plan and avoids
invalidating unrelated applications that share the same zone. An `everything`
mode is also available.

## Requirements

- A Cloudflare account with Workers enabled
- A domain managed by Cloudflare
- A Coolify instance with webhook notifications
- For local deployment: Node.js 22 or newer and pnpm

## Deploy in one click

Use the **Deploy to Cloudflare** button at the top of this README. Cloudflare
will fork this repository into your account, ask for the required secrets, and
deploy the Worker.

You need three values:

| Binding | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An API token with `Zone / Cache Purge` permission, restricted to the target zone |
| `CLOUDFLARE_ZONE_ID` | The Zone ID shown on the domain's Cloudflare Overview page |
| `WEBHOOK_SECRET` | A unique random value of at least 32 characters |

After deployment, continue with [Configure Coolify](#configure-coolify).

## Deploy from your machine

Clone the repository and install the pinned dependencies:

```sh
git clone https://github.com/4xx22/coolify-cloudflare-cache-purge.git
cd coolify-cloudflare-cache-purge
corepack enable
pnpm install --frozen-lockfile
```

Authenticate Wrangler:

```sh
pnpm wrangler login
```

Create the required Worker secrets. Wrangler prompts for each value without
writing it to the repository:

```sh
pnpm wrangler secret put CLOUDFLARE_API_TOKEN
pnpm wrangler secret put CLOUDFLARE_ZONE_ID
pnpm wrangler secret put WEBHOOK_SECRET
```

Validate and deploy:

```sh
pnpm run check
pnpm run deploy
```

Wrangler prints a URL similar to:

```text
https://coolify-cloudflare-cache-purge.<your-subdomain>.workers.dev
```

## Create the Cloudflare API token

1. Open **Cloudflare Dashboard → My Profile → API Tokens**.
2. Select **Create Custom Token**.
3. Add the permission **Zone → Cache Purge → Purge**.
4. Under **Zone Resources**, restrict the token to the single target zone.
5. Create and copy the token. It is shown only once.

Do not use a Global API Key. The scoped API token is the least-privilege
credential required by Cloudflare's cache purge API.

## Configure Coolify

Coolify currently accepts a webhook URL but does not provide a custom
authentication-header field. Add the shared secret as the `token` query
parameter:

```text
https://coolify-cloudflare-cache-purge.<your-subdomain>.workers.dev/webhook?token=<WEBHOOK_SECRET>
```

Then:

1. Open **Coolify → Notifications → Webhook**.
2. Paste the complete URL.
3. Save and enable the webhook provider.
4. Enable **Deployment Success** notifications.
5. Optionally send a test notification. Test events are acknowledged but do
   not purge the cache.

Treat the complete webhook URL as a credential because it contains the shared
secret.

## Configuration

Non-secret settings are in `wrangler.jsonc` and can also be configured in the
Cloudflare dashboard.

| Variable | Default | Description |
| --- | --- | --- |
| `PURGE_MODE` | `hostname` | `hostname` purges only deployed hosts; `everything` purges the entire zone |
| `ALLOWED_APPLICATION_UUIDS` | empty | Optional comma-separated Coolify application UUID allowlist |
| `PURGE_HOSTNAMES` | empty | Optional comma-separated hostname override when Coolify's `fqdn` is absent or unsuitable |

Examples:

```jsonc
{
  "vars": {
    "PURGE_MODE": "hostname",
    "ALLOWED_APPLICATION_UUIDS": "app-uuid-1,app-uuid-2",
    "PURGE_HOSTNAMES": "example.com,www.example.com"
  }
}
```

When `PURGE_HOSTNAMES` is empty, the Worker reads both `fqdn` and
`preview_fqdn`. Comma-separated Coolify domains are supported and duplicate
hostnames are removed.

## Endpoint behavior

| Request | Status | Result |
| --- | --- | --- |
| `GET /` or `GET /health` | `200` | Health response |
| Authenticated `deployment_success` | `200` | Cache purged |
| Other authenticated Coolify event | `200` | Event ignored |
| Invalid secret | `401` | Request rejected |
| Invalid JSON or content type | `400` / `415` | Request rejected |
| Missing hostname in `hostname` mode | `422` | Configuration or payload must be corrected |
| Cloudflare API failure | `502` | Failure returned so the sender can detect it |

For manual requests, the Worker also accepts
`Authorization: Bearer <WEBHOOK_SECRET>`.

## Local development

Copy the example secrets file and replace its placeholders:

```sh
cp .dev.vars.example .dev.vars
pnpm run dev
```

`.dev.vars` is ignored by Git. Never commit real credentials.

Run the test suite and deployment dry run:

```sh
pnpm run check
```

Tests use Cloudflare's current Vitest integration and run inside the `workerd`
runtime.

## Security notes

- Use a long, unique webhook secret.
- Restrict the Cloudflare API token to `Zone / Cache Purge` on one zone.
- Set `ALLOWED_APPLICATION_UUIDS` when one Coolify instance deploys multiple
  applications.
- Rotate the webhook secret if the full URL appears in logs, screenshots, or
  support tickets.
- The Worker never returns or logs either secret.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## AI disclosure

**The entire project is AI-generated.** Its source code, tests, documentation,
configuration, and repository setup were all created using artificial
intelligence. Users should review and validate the project for their own
security and production requirements.

## License

[MIT](LICENSE)
