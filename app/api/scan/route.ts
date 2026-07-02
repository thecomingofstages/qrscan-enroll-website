import type { NextRequest } from "next/server";

const BASE_URL = process.env.BASE_URL;

if (!BASE_URL) {
  // Surfaced once at module load — easier to spot in dev logs than per-request.
  console.warn(
    "[scan route] BASE_URL is not set. Set it in .env.local (e.g. BASE_URL=https://api.example.com).",
  );
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
      headers: { "Content-Type": "application/json" },
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
      error: errBody.error ?? upstream.statusText ?? "UpstreamError",
      message: errBody.message,
      details: errBody.details ?? parsed,
    },
    { status: upstream.status },
  );
}
