import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import test from "node:test";
import { once } from "node:events";

import {
  CAPABILITY_HEADER,
  PEER_ADDRESS_HEADER,
  TRUSTED_PEER_HEADER,
} from "../lib/dashboard-authorization.ts";
import { applyDashboardBoundary } from "../lib/dashboard-boundary.ts";

/**
 * These drive the boundary with real TCP connections and real HTTP requests.
 * The previous versions read `server/dashboard-server.ts` as text and regex
 * matched it, so each would have passed with the control it named removed.
 */

const MARKER = "server-side-marker-value";

interface Harness {
  url: string;
  lanUrl: string | null;
  seen: IncomingMessage["headers"][];
  close: () => Promise<void>;
}

async function startHarness(host = "127.0.0.1"): Promise<Harness> {
  const seen: IncomingMessage["headers"][] = [];

  const server: Server = createServer((request, response) => {
    if (!applyDashboardBoundary(request, response, MARKER)) return;

    // Stands in for the Next.js handler: records exactly what it would read.
    seen.push({ ...request.headers });
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  server.listen(0, host);
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind a TCP port");
  }

  const lan = Object.values(networkInterfaces())
    .flat()
    .find((item) => item && item.family === "IPv4" && !item.internal);

  return {
    url: `http://127.0.0.1:${address.port}`,
    lanUrl: lan ? `http://${lan.address}:${address.port}` : null,
    seen,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

test("a loopback request reaches the handler carrying the server's marker", async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(`${harness.url}/api/collector/snapshot`);

    assert.equal(response.status, 200);
    assert.equal(harness.seen.length, 1);
    assert.equal(harness.seen[0]?.[TRUSTED_PEER_HEADER], MARKER);
    assert.equal(harness.seen[0]?.[PEER_ADDRESS_HEADER], "127.0.0.1");
  } finally {
    await harness.close();
  }
});

test("an inbound trusted-peer header is replaced, not merged", async () => {
  const harness = await startHarness();
  try {
    await fetch(harness.url, {
      headers: {
        [TRUSTED_PEER_HEADER]: "attacker-supplied",
        [PEER_ADDRESS_HEADER]: "127.0.0.1",
      },
    });

    const headers = harness.seen[0];
    assert.equal(headers?.[TRUSTED_PEER_HEADER], MARKER);
    assert.equal(
      String(headers?.[TRUSTED_PEER_HEADER]).includes("attacker-supplied"),
      false,
      "the attacker value must not survive alongside the real marker",
    );
    assert.equal(headers?.[PEER_ADDRESS_HEADER], "127.0.0.1");
  } finally {
    await harness.close();
  }
});

test("mixed-case and repeated marker headers are all removed", async () => {
  const harness = await startHarness();
  try {
    // Sent raw, because fetch normalises header names before transmission.
    const { port } = new URL(harness.url);
    const raw = [
      "GET / HTTP/1.1",
      `Host: 127.0.0.1:${port}`,
      "X-QuotaOps-Peer: attacker-one",
      "x-QUOTAOPS-peer: attacker-two",
      "X-QUOTAOPS-PEER-ADDRESS: 10.0.0.9",
      "Connection: close",
      "",
      "",
    ].join("\r\n");

    const { connect } = await import("node:net");
    const socket = connect(Number(port), "127.0.0.1");
    await once(socket, "connect");
    socket.write(raw);
    socket.setTimeout(5_000, () => socket.destroy());
    await once(socket, "close");

    const headers = harness.seen[0];
    assert.equal(headers?.[TRUSTED_PEER_HEADER], MARKER);
    assert.equal(headers?.[PEER_ADDRESS_HEADER], "127.0.0.1");
  } finally {
    await harness.close();
  }
});

// Catches a proxy that announces itself. A transparent relay sends none of
// these headers and is not detectable here; see Risk C in
// docs/residual-risk-decision.md.
test("a self-identifying proxy is refused before the handler runs", async () => {
  for (const header of [
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-real-ip",
    "forwarded",
  ]) {
    const harness = await startHarness();
    try {
      const response = await fetch(harness.url, {
        headers: { [header]: "203.0.113.9" },
      });

      assert.equal(response.status, 403, `${header} should be refused`);
      assert.deepEqual(await response.json(), { error: "forwarded_request" });
      assert.equal(
        harness.seen.length,
        0,
        `${header} must not reach the handler`,
      );
    } finally {
      await harness.close();
    }
  }
});

test("a capability header does not reach the handler behind a declared proxy", async () => {
  const harness = await startHarness();
  try {
    const response = await fetch(harness.url, {
      headers: {
        [CAPABILITY_HEADER]: "qo1.99999999999999.whatever",
        "x-forwarded-for": "203.0.113.9",
      },
    });

    assert.equal(response.status, 403);
    assert.equal(harness.seen.length, 0);
  } finally {
    await harness.close();
  }
});

test("a non-loopback peer is refused and its socket destroyed", async (t) => {
  // Binding every interface lets the test connect from the host's own LAN
  // address, which produces a genuinely non-loopback peer.
  const harness = await startHarness("0.0.0.0");
  try {
    if (!harness.lanUrl) {
      t.skip("no non-loopback IPv4 interface available");
      return;
    }

    let status: number | null = null;
    try {
      const response = await fetch(harness.lanUrl, {
        signal: AbortSignal.timeout(5_000),
      });
      status = response.status;
      await response.arrayBuffer();
    } catch {
      // The socket is destroyed, so the request may fail or time out instead.
      status = null;
    }

    assert.equal(
      status === null || status === 403,
      true,
      `expected refusal, got HTTP ${String(status)}`,
    );
    assert.equal(
      harness.seen.length,
      0,
      "a non-loopback peer must never reach the handler",
    );
  } finally {
    await harness.close();
  }
});
