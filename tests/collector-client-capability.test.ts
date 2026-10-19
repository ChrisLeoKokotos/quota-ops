import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { fetchCollectorSnapshot } from "../lib/collector-client.ts";

type FetchArgs = Parameters<typeof fetch>;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EMPTY_SNAPSHOT = {
  version: 1,
  generatedAt: "2026-10-15T12:00:00.000Z",
  accounts: [],
};

interface Call {
  path: string;
  capability: string | null;
}

/**
 * Routes the two dashboard endpoints and records what each snapshot request
 * presented, so a test can assert the capability was refreshed rather than
 * merely that the call eventually succeeded.
 */
function stubDashboard(
  capabilities: string[],
  snapshotStatus: (capability: string | null) => number,
): Call[] {
  const calls: Call[] = [];
  let minted = 0;

  globalThis.fetch = (async (...args: FetchArgs) => {
    const url = String(args[0]);
    const init = args[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers ?? {});
    const capability = headers.get("X-QuotaOps-Capability");
    const path = url.replace("/api/collector", "");

    calls.push({ path, capability });

    if (path === "/capability") {
      const value = capabilities[Math.min(minted, capabilities.length - 1)];
      minted += 1;
      return jsonResponse({ capability: value });
    }

    const status = snapshotStatus(capability);
    return status === 200
      ? jsonResponse(EMPTY_SNAPSHOT)
      : jsonResponse({ error: "forbidden" }, status);
  }) as typeof fetch;

  return calls;
}

test("the dashboard mints a capability before its first snapshot request", async () => {
  const calls = stubDashboard(["qo1.1.first"], () => 200);

  await fetchCollectorSnapshot();

  assert.deepEqual(
    calls.map((call) => call.path),
    ["/capability", "/snapshot"],
  );
  assert.equal(calls[1]?.capability, "qo1.1.first");
});

test("an expired capability is replaced and the snapshot retried once", async () => {
  // The cached capability from the previous test is now treated as expired.
  const calls = stubDashboard(
    ["qo1.2.renewed"],
    (capability) => (capability === "qo1.2.renewed" ? 200 : 403),
  );

  const snapshot = await fetchCollectorSnapshot();

  assert.equal(snapshot.accounts.length, 0);
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/snapshot", "/capability", "/snapshot"],
  );
  // The retry presented the freshly minted capability, not the stale one.
  assert.equal(calls[2]?.capability, "qo1.2.renewed");
});

test("the renewed capability is reused rather than re-minted every poll", async () => {
  const calls = stubDashboard(["qo1.3.unused"], () => 200);

  await fetchCollectorSnapshot();

  assert.deepEqual(
    calls.map((call) => call.path),
    ["/snapshot"],
  );
  assert.equal(calls[0]?.capability, "qo1.2.renewed");
});

test("a persistent 403 fails instead of minting capabilities in a loop", async () => {
  const calls = stubDashboard(["qo1.4.a", "qo1.4.b"], () => 403);

  await assert.rejects(
    () => fetchCollectorSnapshot(),
    /Collector returned HTTP 403/,
  );

  // Exactly one renewal attempt: snapshot, capability, snapshot, then stop.
  assert.deepEqual(
    calls.map((call) => call.path),
    ["/snapshot", "/capability", "/snapshot"],
  );
});

test("a refused capability endpoint surfaces as an error, not a silent pass", async () => {
  globalThis.fetch = (async (...args: FetchArgs) => {
    const path = String(args[0]).replace("/api/collector", "");
    return path === "/capability"
      ? jsonResponse({ error: "forbidden" }, 403)
      : jsonResponse({ error: "forbidden" }, 403);
  }) as typeof fetch;

  await assert.rejects(
    () => fetchCollectorSnapshot(),
    /Dashboard capability unavailable \(HTTP 403\)/,
  );
});

test("a malformed capability response is rejected", async () => {
  globalThis.fetch = (async (...args: FetchArgs) => {
    const path = String(args[0]).replace("/api/collector", "");
    if (path === "/capability") return jsonResponse({ capability: 42 });
    return jsonResponse({ error: "forbidden" }, 403);
  }) as typeof fetch;

  await assert.rejects(
    () => fetchCollectorSnapshot(),
    /Dashboard capability response was malformed/,
  );
});

test("the snapshot request never carries the retired client marker", async () => {
  const seen: Headers[] = [];
  globalThis.fetch = (async (...args: FetchArgs) => {
    const init = args[1] as RequestInit | undefined;
    seen.push(new Headers(init?.headers ?? {}));
    const path = String(args[0]).replace("/api/collector", "");
    return path === "/capability"
      ? jsonResponse({ capability: "qo1.7.value" })
      : jsonResponse(EMPTY_SNAPSHOT);
  }) as typeof fetch;

  await fetchCollectorSnapshot();

  for (const headers of seen) {
    assert.equal(headers.get("X-QuotaOps-Client"), null);
  }
});
