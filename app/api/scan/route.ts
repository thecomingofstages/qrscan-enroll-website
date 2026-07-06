import type { NextRequest } from "next/server";

const BASE_URL = process.env.BASE_URL;
const API_TOKEN =
  process.env.API_TOKEN ??
  process.env.ADMIN_TOKEN ??
  process.env.BEARER_TOKEN ??
  process.env.SCAN_TOKEN ??
  process.env.SCAN_API_TOKEN;

if (!BASE_URL) {
  // Surfaced once at module load — easier to spot in dev logs than per-request.
  console.warn(
    "[scan route] BASE_URL is not set. Set it in .env.local (e.g. BASE_URL=https://api.example.com).",
  );
}

if (!API_TOKEN) {
  console.warn(
    "[scan route] API token is not set. Set API_TOKEN or ADMIN_TOKEN in .env.local.",
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

  if (!API_TOKEN) {
    return Response.json(
      {
        status: 500,
        error: "ConfigurationError",
        details:
          "API token is not configured on the server. Set API_TOKEN, ADMIN_TOKEN, BEARER_TOKEN, SCAN_TOKEN, or SCAN_API_TOKEN in .env.local.",
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
        details: "Request body must be valid JSON with qr_token and event_id.",
      },
      { status: 400 },
    );
  }

  const qr_token =
    typeof body.qr_token === "string" ? body.qr_token.trim() : "";
  const event_id =
    typeof body.event_id === "string" ? body.event_id.trim() : "";

  if (!qr_token || !event_id) {
    return Response.json(
      {
        status: 400,
        error: "ValidationError",
        details: "Both qr_token and event_id are required.",
      },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${BASE_URL}/events/scan`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
      },
      body: JSON.stringify({ qr_token, event_id }),
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
    return Response.json(
      { status: upstream.status, data: parsed },
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
