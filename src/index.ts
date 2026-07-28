const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_SECRET_LENGTH = 1024;

export interface Env {
  CLOUDFLARE_API_TOKEN: string;
  WEBHOOK_SECRET: string;
  PURGE_MODE?: string;
  ALLOWED_APPLICATION_UUIDS?: string;
  PURGE_HOSTNAMES?: string;
}

interface CoolifyDeploymentSuccess {
  success: true;
  event: "deployment_success";
  message?: string;
  application_name?: string;
  application_uuid?: string;
  deployment_uuid?: string;
  deployment_url?: string;
  project?: string;
  environment?: string;
  fqdn?: string;
  preview_fqdn?: string;
  pull_request_id?: number;
}

interface CloudflareApiResponse<T> {
  success: boolean;
  result?: T;
  result_info?: {
    page?: number;
    total_pages?: number;
  };
  errors?: Array<{
    code?: number;
    message?: string;
  }>;
  messages?: Array<{
    code?: number;
    message?: string;
  }>;
}

interface CloudflareZone {
  id: string;
  name: string;
}

interface PurgeTarget {
  zoneId: string;
  zoneName: string;
  hostnames: string[];
}

interface PurgeResult extends PurgeTarget {
  purgeId?: string;
}

type PurgeMode = "hostname" | "everything";

function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = new Headers(additionalHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(JSON.stringify(body), { status, headers });
}

async function sha256(value: string): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function secretsMatch(candidate: string, expected: string): Promise<boolean> {
  if (
    candidate.length === 0 ||
    expected.length === 0 ||
    candidate.length > MAX_SECRET_LENGTH ||
    expected.length > MAX_SECRET_LENGTH
  ) {
    return false;
  }

  const [candidateHash, expectedHash] = await Promise.all([
    sha256(candidate),
    sha256(expected),
  ]);

  let difference = candidate.length ^ expected.length;
  for (let index = 0; index < candidateHash.length; index += 1) {
    difference |= candidateHash[index] ^ expectedHash[index];
  }

  return difference === 0;
}

function getProvidedSecret(request: Request): string {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }

  return new URL(request.url).searchParams.get("token") ?? "";
}

function parseCommaSeparated(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function extractHostnames(value: string | undefined): string[] {
  const hostnames = new Set<string>();

  for (const item of parseCommaSeparated(value)) {
    try {
      const url = new URL(item.includes("://") ? item : `https://${item}`);
      if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname) {
        hostnames.add(url.hostname);
      }
    } catch {
      // Invalid entries are ignored. A useful error is returned if none are valid.
    }
  }

  return [...hostnames];
}

function getPurgeMode(value: string | undefined): PurgeMode | null {
  const normalized = (value ?? "hostname").trim().toLowerCase();
  return normalized === "hostname" || normalized === "everything"
    ? normalized
    : null;
}

function isAllowedApplication(
  payload: CoolifyDeploymentSuccess,
  configuredAllowlist: string | undefined,
): boolean {
  const allowlist = parseCommaSeparated(configuredAllowlist);
  return (
    allowlist.length === 0 ||
    (typeof payload.application_uuid === "string" &&
      allowlist.includes(payload.application_uuid))
  );
}

function isDeploymentSuccess(
  value: unknown,
): value is CoolifyDeploymentSuccess {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return payload.success === true && payload.event === "deployment_success";
}

async function readJsonBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RangeError("Request body is too large.");
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    throw new RangeError("Request body is too large.");
  }

  return JSON.parse(body) as unknown;
}

async function parseCloudflareResponse<T>(
  response: Response,
): Promise<CloudflareApiResponse<T> | null> {
  try {
    return (await response.json()) as CloudflareApiResponse<T>;
  } catch {
    return null;
  }
}

function cloudflareError(
  operation: string,
  response: Response,
  result: CloudflareApiResponse<unknown> | null,
): Error {
  const details = result?.errors
    ?.map((error) => error.message)
    .filter((message): message is string => Boolean(message))
    .join("; ");

  return new Error(
    details
      ? `Cloudflare ${operation} failed: ${details}`
      : `Cloudflare ${operation} failed with HTTP ${response.status}.`,
  );
}

async function listCloudflareZones(env: Env): Promise<CloudflareZone[]> {
  const zones: CloudflareZone[] = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = new URL(`${CLOUDFLARE_API_BASE_URL}/zones`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    url.searchParams.set("status", "active");

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
      },
    });
    const result = await parseCloudflareResponse<CloudflareZone[]>(response);

    if (!response.ok || result?.success !== true || !Array.isArray(result.result)) {
      throw cloudflareError("zone discovery", response, result);
    }

    zones.push(
      ...result.result.filter(
        (zone) =>
          typeof zone.id === "string" &&
          zone.id.length > 0 &&
          typeof zone.name === "string" &&
          zone.name.length > 0,
      ),
    );

    totalPages = result.result_info?.total_pages ?? 1;
    page += 1;
  } while (page <= totalPages && page <= 100);

  if (totalPages > 100) {
    throw new Error("Cloudflare zone discovery exceeded the pagination limit.");
  }

  return zones;
}

function resolveZones(
  hostnames: string[],
  zones: CloudflareZone[],
): { targets: PurgeTarget[]; unresolved: string[] } {
  const normalizedZones = zones
    .map((zone) => ({
      ...zone,
      name: zone.name.toLowerCase().replace(/\.$/, ""),
    }))
    .sort((left, right) => right.name.length - left.name.length);
  const targets = new Map<string, PurgeTarget>();
  const unresolved: string[] = [];

  for (const hostname of hostnames) {
    const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");
    const zone = normalizedZones.find(
      (candidate) =>
        normalizedHostname === candidate.name ||
        normalizedHostname.endsWith(`.${candidate.name}`),
    );

    if (!zone) {
      unresolved.push(hostname);
      continue;
    }

    const target = targets.get(zone.id) ?? {
      zoneId: zone.id,
      zoneName: zone.name,
      hostnames: [],
    };
    target.hostnames.push(hostname);
    targets.set(zone.id, target);
  }

  return { targets: [...targets.values()], unresolved };
}

async function getPurgeTargets(
  env: Env,
  hostnames: string[],
): Promise<PurgeTarget[]> {
  const zones = await listCloudflareZones(env);
  const { targets, unresolved } = resolveZones(hostnames, zones);

  if (unresolved.length > 0) {
    throw new RangeError(
      `No accessible Cloudflare zone was found for: ${unresolved.join(", ")}.`,
    );
  }

  return targets;
}

async function purgeCloudflareCache(
  env: Env,
  target: PurgeTarget,
  mode: PurgeMode,
): Promise<PurgeResult> {
  const purgeBody =
    mode === "everything"
      ? { purge_everything: true }
      : { hosts: target.hostnames };

  const response = await fetch(
    `${CLOUDFLARE_API_BASE_URL}/zones/${encodeURIComponent(target.zoneId)}/purge_cache`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(purgeBody),
    },
  );
  const result = await parseCloudflareResponse<{ id?: string }>(response);

  if (!response.ok || result?.success !== true) {
    throw cloudflareError("cache purge", response, result);
  }

  return { ...target, purgeId: result.result?.id };
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return jsonResponse({
      service: "coolify-cloudflare-cache-purge",
      status: "ok",
    });
  }

  if (url.pathname !== "/webhook") {
    return jsonResponse({ error: "Not found." }, 404);
  }

  if (request.method !== "POST") {
    return jsonResponse(
      { error: "Method not allowed." },
      405,
      { Allow: "POST" },
    );
  }

  if (
    typeof env.WEBHOOK_SECRET !== "string" ||
    env.WEBHOOK_SECRET.length < 32 ||
    typeof env.CLOUDFLARE_API_TOKEN !== "string" ||
    env.CLOUDFLARE_API_TOKEN.length === 0
  ) {
    console.error("One or more required secrets are missing or invalid.");
    return jsonResponse({ error: "The Worker is incorrectly configured." }, 500);
  }

  if (!(await secretsMatch(getProvidedSecret(request), env.WEBHOOK_SECRET))) {
    return jsonResponse({ error: "Unauthorized." }, 401);
  }

  const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    return jsonResponse({ error: "Content-Type must be application/json." }, 415);
  }

  let payload: unknown;
  try {
    payload = await readJsonBody(request);
  } catch (error) {
    const message =
      error instanceof RangeError
        ? error.message
        : "The request body must contain valid JSON.";
    return jsonResponse({ error: message }, error instanceof RangeError ? 413 : 400);
  }

  if (!isDeploymentSuccess(payload)) {
    return jsonResponse({
      action: "ignored",
      reason: "Only successful deployment events trigger a cache purge.",
    });
  }

  if (!isAllowedApplication(payload, env.ALLOWED_APPLICATION_UUIDS)) {
    return jsonResponse({
      action: "ignored",
      reason: "The application is not in the configured allowlist.",
    });
  }

  const mode = getPurgeMode(env.PURGE_MODE);
  if (mode === null) {
    console.error("Invalid PURGE_MODE configuration.");
    return jsonResponse({ error: "The Worker is incorrectly configured." }, 500);
  }

  const overrideHostnames = extractHostnames(env.PURGE_HOSTNAMES);
  const payloadHostnames = extractHostnames(
    [payload.fqdn, payload.preview_fqdn].filter(Boolean).join(","),
  );
  const hostnames =
    overrideHostnames.length > 0 ? overrideHostnames : payloadHostnames;

  if (hostnames.length === 0) {
    return jsonResponse(
      {
        error:
          "No valid hostname was found in the Coolify payload or PURGE_HOSTNAMES configuration.",
      },
      422,
    );
  }

  try {
    const targets = await getPurgeTargets(env, hostnames);
    const purges: PurgeResult[] = [];

    for (const target of targets) {
      purges.push(await purgeCloudflareCache(env, target, mode));
    }

    const purgeSummary = purges.map((purge) => ({
      zone: purge.zoneName,
      hostnames: mode === "hostname" ? purge.hostnames : undefined,
      purge_id: purge.purgeId,
    }));

    console.log(
      JSON.stringify({
        event: "cache_purged",
        application_uuid: payload.application_uuid,
        deployment_uuid: payload.deployment_uuid,
        mode,
        purges: purgeSummary,
      }),
    );

    return jsonResponse({
      action: "purged",
      application_uuid: payload.application_uuid,
      deployment_uuid: payload.deployment_uuid,
      mode,
      purges: purgeSummary,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      return jsonResponse({ error: error.message }, 422);
    }

    const message =
      error instanceof Error ? error.message : "Cloudflare cache purge failed.";
    console.error(
      JSON.stringify({
        event: "cache_purge_failed",
        application_uuid: payload.application_uuid,
        deployment_uuid: payload.deployment_uuid,
        message,
      }),
    );

    return jsonResponse({ error: message }, 502);
  }
}

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
