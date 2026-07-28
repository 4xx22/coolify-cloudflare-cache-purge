import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type Env } from "../src/index";

const baseEnv: Env = {
  CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
  WEBHOOK_SECRET: "test-webhook-secret-at-least-32-characters",
  PURGE_MODE: "hostname",
};

const deploymentPayload = {
  success: true,
  event: "deployment_success",
  message: "New version successfully deployed",
  application_name: "example",
  application_uuid: "app-uuid",
  deployment_uuid: "deployment-uuid",
  project: "website",
  environment: "production",
  fqdn: "https://example.com, https://www.example.com/path",
};

function webhookRequest(
  body: unknown = deploymentPayload,
  token = baseEnv.WEBHOOK_SECRET,
): Request {
  return new Request(`https://worker.example/webhook?token=${token}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function cloudflareZonesResponse(
  zones: Array<{ id: string; name: string }> = [
    { id: "zone-example-com", name: "example.com" },
  ],
): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result: zones,
    result_info: { page: 1, total_pages: 1 },
  });
}

function successfulPurgeResponse(id = "purge-id"): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result: { id },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Coolify Cloudflare cache purge Worker", () => {
  it("exposes a health endpoint without configuration details", async () => {
    const response = await handleRequest(
      new Request("https://worker.example/health"),
      baseEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "coolify-cloudflare-cache-purge",
      status: "ok",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects requests with an invalid webhook secret", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handleRequest(webhookRequest(undefined, "wrong"), baseEnv);

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(warnSpy.mock.calls[0][0]))).toMatchObject({
      event: "webhook_rejected",
      message: "Rejected webhook request because authentication failed.",
      status_code: 401,
    });
    expect(String(warnSpy.mock.calls[0][0])).not.toContain("wrong");
    expect(String(warnSpy.mock.calls[0][0])).not.toContain(
      baseEnv.WEBHOOK_SECRET,
    );
  });

  it("logs invalid Worker configuration without exposing secrets", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = await handleRequest(webhookRequest(), {
      ...baseEnv,
      CLOUDFLARE_API_TOKEN: "",
    });

    expect(response.status).toBe(500);
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({
      event: "worker_configuration_error",
      message:
        "Worker configuration is invalid because required secrets are missing or malformed.",
      status_code: 500,
    });
    expect(String(errorSpy.mock.calls[0][0])).not.toContain(
      baseEnv.WEBHOOK_SECRET,
    );
  });

  it("logs unexpected runtime errors without exposing their message", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const throwingEnv = new Proxy(baseEnv, {
      get() {
        throw new Error("sensitive unexpected details");
      },
    });
    const response = await handleRequest(webhookRequest(), throwingEnv);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "An unexpected internal error occurred.",
    });
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({
      event: "worker_unexpected_error",
      message: "An unexpected internal Worker error occurred.",
      status_code: 500,
      error_type: "Error",
    });
    expect(String(errorSpy.mock.calls[0][0])).not.toContain(
      "sensitive unexpected details",
    );
  });

  it("logs malformed JSON requests", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await handleRequest(
      new Request(
        `https://worker.example/webhook?token=${baseEnv.WEBHOOK_SECRET}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        },
      ),
      baseEnv,
    );

    expect(response.status).toBe(400);
    expect(JSON.parse(String(warnSpy.mock.calls[0][0]))).toMatchObject({
      event: "webhook_rejected",
      message: "The request body must contain valid JSON.",
      status_code: 400,
    });
  });

  it("logs unsupported webhook methods", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await handleRequest(
      new Request("https://worker.example/webhook"),
      baseEnv,
    );

    expect(response.status).toBe(405);
    expect(JSON.parse(String(warnSpy.mock.calls[0][0]))).toMatchObject({
      event: "webhook_rejected",
      message:
        "Rejected webhook request because the HTTP method is not allowed.",
      status_code: 405,
    });
  });

  it("logs unsupported webhook content types", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await handleRequest(
      new Request(
        `https://worker.example/webhook?token=${baseEnv.WEBHOOK_SECRET}`,
        {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        },
      ),
      baseEnv,
    );

    expect(response.status).toBe(415);
    expect(JSON.parse(String(warnSpy.mock.calls[0][0]))).toMatchObject({
      event: "webhook_rejected",
      message:
        "Rejected webhook request because Content-Type is not application/json.",
      status_code: 415,
    });
  });

  it("logs oversized webhook bodies", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await handleRequest(
      new Request(
        `https://worker.example/webhook?token=${baseEnv.WEBHOOK_SECRET}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(32 * 1024 + 1),
          },
          body: "{}",
        },
      ),
      baseEnv,
    );

    expect(response.status).toBe(413);
    expect(JSON.parse(String(warnSpy.mock.calls[0][0]))).toMatchObject({
      event: "webhook_rejected",
      message: "Request body is too large.",
      status_code: 413,
    });
  });

  it("ignores events other than a successful deployment", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handleRequest(
      webhookRequest({
        success: false,
        event: "deployment_failed",
        message: "Deployment failed",
      }),
      baseEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: "ignored" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      event: "webhook_ignored",
      message:
        "Ignored Coolify webhook because it is not a successful deployment event.",
      status_code: 200,
      coolify_event: "deployment_failed",
    });
  });

  it("ignores applications outside the optional allowlist", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handleRequest(webhookRequest(), {
      ...baseEnv,
      ALLOWED_APPLICATION_UUIDS: "another-app",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: "ignored" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      event: "webhook_ignored",
      message:
        "Ignored successful deployment because the application is not in the allowlist.",
      status_code: 200,
      application_uuid: "app-uuid",
      deployment_uuid: "deployment-uuid",
    });
  });

  it("logs unsupported purge mode configuration", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handleRequest(webhookRequest(), {
      ...baseEnv,
      PURGE_MODE: "unsupported",
    });

    expect(response.status).toBe(500);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({
      event: "worker_configuration_error",
      message:
        "Worker configuration is invalid because PURGE_MODE is unsupported.",
      status_code: 500,
      application_uuid: "app-uuid",
      deployment_uuid: "deployment-uuid",
    });
  });

  it("logs deployments without a valid hostname", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handleRequest(
      webhookRequest({
        ...deploymentPayload,
        fqdn: undefined,
      }),
      baseEnv,
    );

    expect(response.status).toBe(422);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(JSON.parse(String(warnSpy.mock.calls[0][0]))).toMatchObject({
      event: "cache_purge_rejected",
      message: "Rejected cache purge because no valid hostname was provided.",
      status_code: 422,
      application_uuid: "app-uuid",
      deployment_uuid: "deployment-uuid",
    });
  });

  it("discovers the zone and purges every hostname in that zone", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(cloudflareZonesResponse())
      .mockResolvedValueOnce(successfulPurgeResponse());
    const response = await handleRequest(webhookRequest(), baseEnv);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: "purged",
      mode: "hostname",
      purges: [
        {
          zone: "example.com",
          hostnames: ["example.com", "www.example.com"],
          purge_id: "purge-id",
        },
      ],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://api.cloudflare.com/client/v4/zones?page=1&per_page=50&status=active",
    );

    const [purgeUrl, purgeInit] = fetchSpy.mock.calls[1];
    expect(purgeUrl).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone-example-com/purge_cache",
    );
    expect(purgeInit).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        hosts: ["example.com", "www.example.com"],
      }),
    });
    expect(new Headers(purgeInit?.headers).get("Authorization")).toBe(
      "Bearer cloudflare-api-token",
    );
    expect(logSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      event: "cache_purged",
      message:
        "Purged Cloudflare cache for 1 zone after Coolify deployment deployment-uuid.",
      application_uuid: "app-uuid",
      deployment_uuid: "deployment-uuid",
    });
  });

  it("groups multiple root domains and purges each matching zone", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        cloudflareZonesResponse([
          { id: "zone-com", name: "example.com" },
          { id: "zone-net", name: "example.net" },
        ]),
      )
      .mockResolvedValueOnce(successfulPurgeResponse("purge-com"))
      .mockResolvedValueOnce(successfulPurgeResponse("purge-net"));
    const response = await handleRequest(
      webhookRequest({
        ...deploymentPayload,
        fqdn: "https://app.example.com,https://example.net",
      }),
      baseEnv,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: "purged",
      purges: [
        {
          zone: "example.com",
          hostnames: ["app.example.com"],
          purge_id: "purge-com",
        },
        {
          zone: "example.net",
          hostnames: ["example.net"],
          purge_id: "purge-net",
        },
      ],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(fetchSpy.mock.calls[1][0]).toContain(
      "/zones/zone-com/purge_cache",
    );
    expect(fetchSpy.mock.calls[2][0]).toContain(
      "/zones/zone-net/purge_cache",
    );
  });

  it("logs completed purges when a later zone fails", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        cloudflareZonesResponse([
          { id: "zone-com", name: "example.com" },
          { id: "zone-net", name: "example.net" },
        ]),
      )
      .mockResolvedValueOnce(successfulPurgeResponse("purge-com"))
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            errors: [{ code: 1000, message: "Cache purge denied" }],
          },
          { status: 403 },
        ),
      );
    const response = await handleRequest(
      webhookRequest({
        ...deploymentPayload,
        fqdn: "https://app.example.com,https://example.net",
      }),
      baseEnv,
    );

    expect(response.status).toBe(502);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({
      event: "cache_purge_failed",
      status_code: 502,
      failed_zone: "example.net",
      completed_purges: [
        {
          zone: "example.com",
          hostnames: ["app.example.com"],
          purge_id: "purge-com",
        },
      ],
    });
  });

  it("supports purging every cached item in each matched zone", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(cloudflareZonesResponse())
      .mockResolvedValueOnce(successfulPurgeResponse());
    const response = await handleRequest(webhookRequest(), {
      ...baseEnv,
      PURGE_MODE: "everything",
    });

    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls[1][1]?.body).toBe(
      JSON.stringify({ purge_everything: true }),
    );
  });

  it("rejects a hostname when the token cannot access its zone", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(cloudflareZonesResponse([]));
    const response = await handleRequest(webhookRequest(), baseEnv);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain(
      "No accessible Cloudflare zone was found",
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warnSpy.mock.calls[0][0]))).toMatchObject({
      event: "cache_purge_rejected",
      message:
        "No accessible Cloudflare zone was found for: example.com, www.example.com.",
      status_code: 422,
      application_uuid: "app-uuid",
      deployment_uuid: "deployment-uuid",
      hostnames: ["example.com", "www.example.com"],
    });
  });

  it("returns an upstream error without exposing credentials", async () => {
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(cloudflareZonesResponse())
      .mockResolvedValueOnce(
        Response.json(
          {
            success: false,
            errors: [{ code: 1000, message: "Cache purge denied" }],
          },
          { status: 403 },
        ),
      );
    const response = await handleRequest(webhookRequest(), baseEnv);
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toContain("Cache purge denied");
    expect(body).not.toContain(baseEnv.CLOUDFLARE_API_TOKEN);
    expect(body).not.toContain(baseEnv.WEBHOOK_SECRET);
    expect(JSON.parse(String(errorSpy.mock.calls[0][0]))).toMatchObject({
      event: "cache_purge_failed",
      message: "Cloudflare cache purge failed: Cache purge denied",
      status_code: 502,
      application_uuid: "app-uuid",
      deployment_uuid: "deployment-uuid",
      hostnames: ["example.com", "www.example.com"],
      mode: "hostname",
    });
    expect(String(errorSpy.mock.calls[0][0])).not.toContain(
      baseEnv.CLOUDFLARE_API_TOKEN,
    );
    expect(String(errorSpy.mock.calls[0][0])).not.toContain(
      baseEnv.WEBHOOK_SECRET,
    );
  });
});
