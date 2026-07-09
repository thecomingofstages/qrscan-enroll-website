import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";

const BASE_URL = process.env.BASE_URL;
const STATIC_API_TOKEN =
  process.env.API_TOKEN ??
  process.env.ADMIN_TOKEN ??
  process.env.BEARER_TOKEN ??
  process.env.SCAN_TOKEN ??
  process.env.SCAN_API_TOKEN;

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET;
const SCAN_ADMIN_SUB = process.env.SCAN_ADMIN_SUB;
const SCAN_ADMIN_NICKNAME = process.env.SCAN_ADMIN_NICKNAME ?? "Scanner";
const SCAN_TOKEN_TTL_SECONDS = 15 * 60;

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

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
  if (JWT_ACCESS_SECRET && SCAN_ADMIN_SUB) {
    try {
      return mintAdminAccessToken();
    } catch (error) {
      console.error("[mark-exchanged route] Failed to mint admin token:", error);
      return null;
    }
  }

  if (STATIC_API_TOKEN) {
    return STATIC_API_TOKEN;
  }

  return null;
}

function extractUserIdFromQrToken(qrToken: string): string | null {
  const [encoded] = qrToken.split(".");
  if (!encoded) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return typeof payload?.user_id === "string" ? payload.user_id : null;
  } catch {
    return null;
  }
}

export async function PATCH(request: NextRequest) {
  if (!BASE_URL) {
    return Response.json(
      { status: 500, error: "ConfigurationError", details: "BASE_URL is not configured on the server." },
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

  let body: { qr_token?: unknown };
  try {
    body = (await request.json()) as { qr_token?: unknown };
  } catch {
    return Response.json(
      { status: 400, error: "BadRequest", details: "Request body must be valid JSON with qr_token." },
      { status: 400 },
    );
  }

  const qr_token = typeof body.qr_token === "string" ? body.qr_token.trim() : "";
  if (!qr_token) {
    return Response.json(
      { status: 400, error: "ValidationError", details: "qr_token is required." },
      { status: 400 },
    );
  }

  const userId = extractUserIdFromQrToken(qr_token);
  if (!userId) {
    return Response.json(
      { status: 400, error: "ValidationError", details: "Could not resolve a user_id from qr_token." },
      { status: 400 },
    );
  }

  try {
    const upstream = await fetch(`${BASE_URL}/admin/stampstore/markexchanged`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ user_id: userId }),
      cache: "no-store",
    });

    const text = await upstream.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (upstream.ok) {
      return Response.json({ status: upstream.status, data: parsed }, { status: upstream.status });
    }

    return Response.json(
      {
        status: upstream.status,
        error: typeof parsed === "object" && parsed && "error" in parsed ? String((parsed as { error?: unknown }).error) : undefined,
        message: typeof parsed === "object" && parsed && "message" in parsed ? String((parsed as { message?: unknown }).message) : undefined,
        details: parsed,
      },
      { status: upstream.status },
    );
  } catch (error) {
    return Response.json(
      { status: 502, error: "UpstreamUnreachable", details: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
