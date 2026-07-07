import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";

const BASE_URL = process.env.BASE_URL;

// Static bearer token — used as-is if set. Several names are accepted so the
// operator can pick whichever convention they prefer.
const STATIC_API_TOKEN =
  process.env.API_TOKEN ??
  process.env.ADMIN_TOKEN ??
  process.env.BEARER_TOKEN ??
  process.env.SCAN_TOKEN ??
  process.env.SCAN_API_TOKEN;

// Credentials for minting a short-lived admin JWT on demand. The upstream
// authenticates /events/scan with HS256 access tokens signed by the matching
// `JWT_ACCESS_SECRET` (the qrscan .env carries the same secret as the API
// deploy), and it looks up the user by `sub`, requiring `role === 'admin'`.
// `SCAN_ADMIN_SUB` must be the `_id` of a real user in the upstream MongoDB
// whose `role` is set to `'admin'`.
const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const SCAN_ADMIN_SUB = process.env.SCAN_ADMIN_SUB;
const SCAN_ADMIN_NICKNAME = process.env.SCAN_ADMIN_NICKNAME ?? "Scanner";
const SCAN_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes — matches the upstream's access-token expiry.

if (!BASE_URL) {
  // Surfaced once at module load — easier to spot in dev logs than per-request.
  console.warn(
    "[scan route] BASE_URL is not set. Set it in .env.local (e.g. BASE_URL=https://api.example.com).",
  );
}

const hasJwtCredentials = Boolean(JWT_ACCESS_SECRET && SCAN_ADMIN_SUB);
if (!hasJwtCredentials && !STATIC_API_TOKEN) {
  console.warn(
    "[scan route] No auth configured. Set SCAN_ADMIN_SUB + JWT_ACCESS_SECRET, or a static API_TOKEN, in .env.local.",
  );
}

function normalizeResponseField(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

type ScanRequestBody = {
  qr_token?: unknown;
  event_id?: unknown;
};

type UpstreamErrorBody = {
  error?: unknown;
  message?: unknown;
  details?: unknown;
  [key: string]: unknown;
};

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Mint a short-lived HS256 access token with the same shape the upstream's
 * `signAccess(payload)` produces: `{ sub, nickname, role: 'admin' }` plus
 * standard `iat`/`exp` claims.
 *
 * Pure Node `crypto` — keeps the project dependency-free.
 */
function mintAdminAccessToken(): string {
  if (!JWT_ACCESS_SECRET || !SCAN_ADMIN_SUB) {
    throw new Error("JWT_ACCESS_SECRET and SCAN_ADMIN_SUB are required to mint an admin token.");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: SCAN_ADMIN_SUB,
    nickname: SCAN_ADMIN_NICKNAME,
    role: "admin" as const,
    iat: now,
    exp: now + SCAN_TOKEN_TTL_SECONDS,
  };
  const headerEncoded = base64url(JSON.stringify(header));
  const payloadEncoded = base64url(JSON.stringify(payload));
  const signingInput = `${headerEncoded}.${payloadEncoded}`;
  const signature = createHmac("sha256", JWT_ACCESS_SECRET)
    .update(signingInput)
    .digest();
  return `${signingInput}.${base64url(signature)}`;
}

function resolveBearerToken(): string | null {
  if (STATIC_API_TOKEN) return STATIC_API_TOKEN;
  if (hasJwtCredentials) {
    try {
      return mintAdminAccessToken();
    } catch (error) {
      console.error("[scan route] Failed to mint admin token:", error);
      return null;
    }
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (!BASE_URL) {
    return Response.json(
      {
        status: 500,
        error: "ConfigurationError",
        details: "BASE_URL is not configured on the server.",
      },
      { status: 500 },
    );
  }

  const bearerToken = resolveBearerToken();
  if (!bearerToken) {
    return Response.json(
      {
        status: 500,
        error: "ConfigurationError",
        details:
          "Server auth is not configured. Set SCAN_ADMIN_SUB + JWT_ACCESS_SECRET (or API_TOKEN) in .env.local.",
      },
      { status: 500 },
    );
  }

  let body: ScanRequestBody;
  try {
    body = (await request.json()) as ScanRequestBody;
  } catch {
    return Response.json(
      {
        status: 400,
        error: "BadRequest",
        details: "Request body must be valid JSON with qr_token and an optional event_id.",
      },
      { status: 400 },
    );
  }

  const qr_token =
    typeof body.qr_token === "string" ? body.qr_token.trim() : "";
  const event_id =
    typeof body.event_id === "string" ? body.event_id.trim() : "";

  if (!qr_token) {
    return Response.json(
      {
        status: 400,
        error: "ValidationError",
        details: "qr_token is required.",
      },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    const upstreamBody = { qr_token } as { qr_token: string; event_id?: string };
    if (event_id) {
      upstreamBody.event_id = event_id;
    }

    upstream = await fetch(`${BASE_URL}/events/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(upstreamBody),
      // Don't let Next.js cache upstream responses.
      cache: "no-store",
    });
  } catch (error) {
    return Response.json(
      {
        status: 502,
        error: "UpstreamUnreachable",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }

  // Try to parse JSON; fall back to raw text if the upstream returned non-JSON.
  let parsed: unknown = null;
  const text = await upstream.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (upstream.ok) {
    const payload =
      parsed && typeof parsed === "object" && parsed !== null && "data" in parsed
        ? (parsed as { data?: unknown }).data
        : parsed;

    return Response.json(
      { status: upstream.status, data: payload },
      { status: upstream.status },
    );
  }

  const errBody = (parsed ?? {}) as UpstreamErrorBody;
  return Response.json(
    {
      status: upstream.status,
      error:
        normalizeResponseField(errBody.error) ??
        normalizeResponseField(upstream.statusText) ??
        "UpstreamError",
      message: normalizeResponseField(errBody.message),
      details:
        normalizeResponseField(errBody.details) ??
        normalizeResponseField(parsed) ??
        undefined,
    },
    { status: upstream.status },
  );
}
