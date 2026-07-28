import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest, type Env } from "../src/index";

const baseEnv: Env = {
  CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
  CLOUDFLARE_ZONE_ID: "zone-id",
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

function successfulCloudflareResponse(): Response {
  return Response.json({
    success: true,
    errors: [],
    messages: [],
    result: { id: "purge-id" },
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

  it("purges every hostname from the Coolify payload", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(successfulCloudflareResponse());
    const response = await handleRequest(webhookRequest(), baseEnv);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: "purged",
      hostnames: ["example.com", "www.example.com"],
      mode: "hostname",
      purge_id: "purge-id",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone-id/purge_cache",
    );
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        hosts: ["example.com", "www.example.com"],
      }),
    });
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer cloudflare-api-token",
    );
  });

  it("supports purging the entire zone", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(successfulCloudflareResponse());
    const payloadWithoutFqdn = { ...deploymentPayload, fqdn: undefined };
    const response = await handleRequest(webhookRequest(payloadWithoutFqdn), {
      ...baseEnv,
      PURGE_MODE: "everything",
    });

    expect(response.status).toBe(200);
    expect(fetchSpy.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ purge_everything: true }),
    );
  });

  it("returns an upstream error without exposing credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          success: false,
          errors: [{ code: 1000, message: "Invalid zone identifier" }],
        },
        { status: 403 },
      ),
    );
    const response = await handleRequest(webhookRequest(), baseEnv);
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toContain("Invalid zone identifier");
    expect(body).not.toContain(baseEnv.CLOUDFLARE_API_TOKEN);
    expect(body).not.toContain(baseEnv.WEBHOOK_SECRET);
  });
});
