import { NextRequest, NextResponse } from "next/server";

import { getOrCreateCollectorToken } from "@/collector/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLLECTOR_URL = "http://127.0.0.1:4317/snapshot";
const MAX_RESPONSE_BYTES = 262_144;

let tokenPromise: Promise<string> | null = null;

function collectorToken(): Promise<string> {
  tokenPromise ??= getOrCreateCollectorToken();
  return tokenPromise;
}

function isAllowedRequest(request: NextRequest): boolean {
  const host = request.headers.get("host") ?? "";
  const hostMatch = /^(localhost|127\.0\.0\.1):(\d{2,5})$/.exec(host);
  if (!hostMatch) return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;

  try {
    const parsed = new URL(origin);
    return (
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      parsed.port === hostMatch[2] &&
      parsed.protocol === "http:"
    );
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isAllowedRequest(request)) {
    return NextResponse.json(
      { error: "forbidden" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const token = await collectorToken();
    const response = await fetch(COLLECTOR_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "collector_unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return NextResponse.json(
        { error: "collector_invalid_response" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
      return NextResponse.json(
        { error: "collector_response_too_large" },
        { status: 502, headers: { "Cache-Control": "no-store" } },
      );
    }

    const payload: unknown = JSON.parse(body) as unknown;
    return NextResponse.json(payload, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "collector_offline" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
