import { NextResponse } from "next/server";

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

export async function GET(): Promise<NextResponse> {
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
