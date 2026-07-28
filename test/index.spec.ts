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
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handleRequest(webhookRequest(undefined, "wrong"), baseEnv);

    expect(response.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores events other than a successful deployment", async () => {
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
  });

  it("ignores applications outside the optional allowlist", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await handleRequest(webhookRequest(), {
      ...baseEnv,
      ALLOWED_APPLICATION_UUIDS: "another-app",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: "ignored" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("discovers the zone and purges every hostname in that zone", async () => {
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
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(cloudflareZonesResponse([]));
    const response = await handleRequest(webhookRequest(), baseEnv);

    expect(response.status).toBe(422);
    expect(await response.text()).toContain(
      "No accessible Cloudflare zone was found",
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("returns an upstream error without exposing credentials", async () => {
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
  });
});
