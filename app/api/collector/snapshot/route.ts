import { NextRequest, NextResponse } from "next/server";

import { getOrCreateCollectorToken } from "@/collector/security";
import {
  PEER_ADDRESS_HEADER,
  evaluateSnapshotRequest,
} from "@/lib/dashboard-authorization";
import { getDashboardRuntime } from "@/lib/dashboard-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COLLECTOR_URL = "http://127.0.0.1:4317/snapshot";
const MAX_RESPONSE_BYTES = 262_144;

let tokenPromise: Promise<string> | null = null;

function collectorToken(): Promise<string> {
  tokenPromise ??= getOrCreateCollectorToken();
  return tokenPromise;
}

/**
 * Dropped after a 401 so `collector:setup -- rotate-token` does not leave the
 * proxy authenticating with a token the collector no longer accepts. Without
 * this the failure is cached for the process lifetime and surfaces as a
 * permanent `collector_offline`, which names the wrong cause.
 */
function forgetCollectorToken(): void {
  tokenPromise = null;
}

async function requestSnapshot(token: string): Promise<Response> {
  return fetch(COLLECTOR_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(3_000),
  });
}

function denied(reason: string): NextResponse {
  // The reason names the failed control, never the expected secret value.
  return NextResponse.json(
    { error: "forbidden", reason },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * QO-SEC-01: authorization is decided from the TCP peer verified by the
 * trusted dashboard server plus an HMAC capability, never from a client
 * marker. Without the trusted server the route fails closed.
 */
function authorize(request: NextRequest): NextResponse | null {
  const dashboardRuntime = getDashboardRuntime();
  if (!dashboardRuntime) return denied("trusted_server_required");

  const decision = evaluateSnapshotRequest({
    remoteAddress: request.headers.get(PEER_ADDRESS_HEADER),
    header: (name) => request.headers.get(name),
    trustedPeerMarker: dashboardRuntime.trustedPeerMarker,
    capabilitySecret: dashboardRuntime.capabilitySecret,
  });

  return decision.allowed ? null : denied(decision.reason);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rejection = authorize(request);
  if (rejection) return rejection;

  try {
    let response = await requestSnapshot(await collectorToken());

    if (response.status === 401) {
      // The token was rotated underneath us; re-read it and try once more.
      forgetCollectorToken();
      response = await requestSnapshot(await collectorToken());
    }

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
