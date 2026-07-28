# Coolify Cloudflare Cache Purge

[![CI](https://github.com/4xx22/coolify-cloudflare-cache-purge/actions/workflows/ci.yml/badge.svg)](https://github.com/4xx22/coolify-cloudflare-cache-purge/actions/workflows/ci.yml)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/4xx22/coolify-cloudflare-cache-purge)

A small, secure Cloudflare Worker that receives
[Coolify webhook notifications](https://coolify.io/docs/knowledge-base/notifications)
and purges an application's Cloudflare cache after a successful deployment.

By default, only the hostnames included in Coolify's `deployment_success`
payload are purged. The Worker automatically finds the matching Cloudflare
zone for every hostname, so one Coolify account webhook can manage applications
across multiple root domains. Failed deployments, test notifications, and
every other Coolify event are ignored.

## How it works

1. Coolify sends a `POST` request after a successful application deployment.
2. The Worker authenticates the request with a shared secret.
3. It validates the `deployment_success` payload and, if configured, the
   application's UUID.
4. It lists the active Cloudflare zones accessible to the API token.
5. It matches every deployed hostname to the most specific zone and groups
   hostnames by zone.
6. It calls Cloudflare's cache purge API once for each matched zone.
7. It returns a structured JSON result to Coolify.

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

You need two values:

| Binding | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An API token with `Zone Read` and `Cache Purge`, restricted to every zone the Worker may manage |
| `WEBHOOK_SECRET` | A unique random value of at least 32 characters |

The fields are intentionally blank. Cloudflare does not generate these
credentials for you: enter your own API token and a newly generated webhook
secret.

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
3. Add **Zone → Zone → Read**.
4. Add **Zone → Cache Purge → Purge**.
5. Under **Zone Resources**, include every domain that this Worker should
   manage. Avoid granting access to unrelated zones.
6. If you add another domain later, update the token to include its zone.
7. Create and copy the token. It is shown only once.

Do not use a Global API Key. The scoped API token is the least-privilege
credential required to discover the matching zones and purge their caches.

## Multiple domains and zones

A Cloudflare zone normally represents one root domain. For example,
`example.com`, `www.example.com`, and `api.example.com` usually share the same
zone, while `example.com` and `example.net` are separate zones.

No Zone ID configuration is required. On each successful deployment, the
Worker lists the zones visible to the token and selects the longest matching
suffix:

```text
app.example.com → example.com
example.net     → example.net
```

If one Coolify payload contains hostnames from several root domains, they are
grouped and purged through separate Cloudflare API calls. If no accessible zone
matches a hostname, the Worker returns `422` and does not start any purge.

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

`PURGE_MODE` is preconfigured in `wrangler.jsonc`. The two optional variables
are deliberately not declared there: Cloudflare's one-click deployment form
treats every declared variable as required, even when its default is an empty
string.

| Variable | Default | Description |
| --- | --- | --- |
| `PURGE_MODE` | `hostname` | `hostname` purges only deployed hosts; `everything` purges every matched zone |
| `ALLOWED_APPLICATION_UUIDS` | empty | Optional comma-separated Coolify application UUID allowlist |
| `PURGE_HOSTNAMES` | empty | Optional comma-separated hostname override when Coolify's `fqdn` is absent or unsuitable |

No action is required if the default behavior is suitable. To use either
optional variable, add it after the first deployment under **Workers &
Pages → your Worker → Settings → Variables and Secrets**, or add it to the
`vars` object in your fork's `wrangler.jsonc` and redeploy:

```jsonc
{
  "vars": {
    "PURGE_MODE": "hostname",
    "ALLOWED_APPLICATION_UUIDS": "app-uuid-1,app-uuid-2",
    "PURGE_HOSTNAMES": "example.com,www.example.com"
  }
}
```

For durable configuration with Workers Builds, commit the variable to your
fork. A value added only in the dashboard may be overwritten by a later source
deployment.

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
| Request body larger than 32 KiB | `413` | Request rejected |
| Non-`POST` request to `/webhook` | `405` | Request rejected |
| Unknown endpoint | `404` | Not found |
| Missing hostname or inaccessible zone | `422` | Payload or token scope must be corrected |
| Invalid Worker configuration | `500` | Configuration must be corrected |
| Cloudflare API failure | `502` | Failure returned so the sender can detect it |

For manual requests, the Worker also accepts
`Authorization: Bearer <WEBHOOK_SECRET>`.

## Observability

Every custom webhook log includes a human-readable `message`, which Cloudflare
indexes as `$metadata.message`, plus a stable `event` and `status_code`.
Application and deployment UUIDs are included when they are available.

| Event | Level | Meaning |
| --- | --- | --- |
| `webhook_rejected` | Warning | Invalid method, authentication, content type, or request body |
| `webhook_ignored` | Log | Unrelated Coolify event or application excluded by the allowlist |
| `worker_configuration_error` | Error | Missing secrets or unsupported purge mode |
| `worker_unexpected_error` | Error | Unexpected runtime failure caught by the final safety handler |
| `cache_purge_rejected` | Warning | Missing hostname or inaccessible Cloudflare zone |
| `cache_purge_failed` | Error | Cloudflare zone discovery or purge API failure |
| `cache_purged` | Log | Cloudflare accepted every required cache purge |

For a partial multi-zone failure, `cache_purge_failed` also includes
`failed_zone` and `completed_purges`.

Secrets and webhook URLs are never included in custom logs.

## Local development

Copy the example secrets file and fill in its blank values:

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
- Grant only `Zone Read` and `Cache Purge`, restricted to the zones managed by
  this Worker.
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
