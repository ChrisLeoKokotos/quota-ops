import { NextRequest, NextResponse } from "next/server";

import {
  PEER_ADDRESS_HEADER,
  evaluateTrustedLocalRequest,
  mintDashboardCapability,
} from "@/lib/dashboard-authorization";
import { getDashboardRuntime } from "@/lib/dashboard-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-issues a snapshot capability for a long-running dashboard tab.
 *
 * It is gated by the same enforceable boundary as the snapshot route — a
 * loopback TCP peer verified by the trusted server — but deliberately does
 * not require a capability, because an expired capability is exactly the
 * condition this endpoint exists to repair. It returns no account data.
 */
export function GET(request: NextRequest): NextResponse {
  const dashboardRuntime = getDashboardRuntime();
  if (!dashboardRuntime) {
    return NextResponse.json(
      { error: "forbidden", reason: "trusted_server_required" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const decision = evaluateTrustedLocalRequest({
    remoteAddress: request.headers.get(PEER_ADDRESS_HEADER),
    header: (name) => request.headers.get(name),
    trustedPeerMarker: dashboardRuntime.trustedPeerMarker,
    capabilitySecret: dashboardRuntime.capabilitySecret,
  });

  if (!decision.allowed) {
    return NextResponse.json(
      { error: "forbidden", reason: decision.reason },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { capability: mintDashboardCapability(dashboardRuntime.capabilitySecret) },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
