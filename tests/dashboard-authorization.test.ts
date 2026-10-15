import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_HEADER,
  PEER_ADDRESS_HEADER,
  TRUSTED_PEER_HEADER,
  createCapabilitySecret,
  evaluateSnapshotRequest,
  evaluateTrustedLocalRequest,
  hasForwardingHeader,
  isLoopbackAddress,
  isLoopbackHostname,
  mintDashboardCapability,
  verifyDashboardCapability,
} from "../lib/dashboard-authorization.ts";

const SECRET = createCapabilitySecret();
const MARKER = "trusted-marker-for-tests";
const NOW = 1_760_000_000_000;

function headersFrom(values: Record<string, string>) {
  const lower = new Map(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return (name: string): string | null => lower.get(name.toLowerCase()) ?? null;
}

function authorizedRequest(overrides: Record<string, string> = {}) {
  return {
    remoteAddress: "127.0.0.1",
    trustedPeerMarker: MARKER,
    capabilitySecret: SECRET,
    now: NOW,
    header: headersFrom({
      host: "127.0.0.1:3000",
      [TRUSTED_PEER_HEADER]: MARKER,
      [CAPABILITY_HEADER]: mintDashboardCapability(SECRET, NOW),
      ...overrides,
    }),
  };
}

test("authorizes a loopback request carrying a valid capability", () => {
  assert.deepEqual(evaluateSnapshotRequest(authorizedRequest()), {
    allowed: true,
  });
});

test("rejects the legacy forgeable dashboard client marker on its own", () => {
  const decision = evaluateSnapshotRequest({
    remoteAddress: "127.0.0.1",
    trustedPeerMarker: MARKER,
    capabilitySecret: SECRET,
    now: NOW,
    header: headersFrom({
      host: "127.0.0.1:3000",
      "x-quotaops-client": "dashboard",
    }),
  });

  assert.deepEqual(decision, {
    allowed: false,
    reason: "untrusted_peer_marker",
  });
});

test("rejects a non-loopback peer even with a valid capability", () => {
  const request = authorizedRequest();
  const decision = evaluateSnapshotRequest({
    ...request,
    remoteAddress: "192.168.1.40",
  });

  assert.deepEqual(decision, { allowed: false, reason: "non_loopback_peer" });
});

test("rejects a forged trusted-peer marker", () => {
  const decision = evaluateSnapshotRequest(
    authorizedRequest({ [TRUSTED_PEER_HEADER]: "trusted-marker-for-tesZ" }),
  );

  assert.deepEqual(decision, {
    allowed: false,
    reason: "untrusted_peer_marker",
  });
});

test("rejects a marker of a different length without throwing", () => {
  const decision = evaluateSnapshotRequest(
    authorizedRequest({ [TRUSTED_PEER_HEADER]: "short" }),
  );

  assert.deepEqual(decision, {
    allowed: false,
    reason: "untrusted_peer_marker",
  });
});

test("flags every proxy header so the trusted server can refuse the request", () => {
  for (const header of [
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-real-ip",
    "forwarded",
  ]) {
    assert.equal(
      hasForwardingHeader(headersFrom({ [header]: "203.0.113.9" })),
      true,
      `expected ${header} to mark the request as proxied`,
    );
  }

  assert.equal(hasForwardingHeader(headersFrom({ host: "127.0.0.1:3000" })), false);
  assert.equal(hasForwardingHeader(() => undefined), false);
});

test("the route evaluator ignores forwarded headers Next.js adds downstream", () => {
  // Next.js synthesizes x-forwarded-* for its own request handling, so the
  // proxy control lives in the trusted server where headers are client input.
  const decision = evaluateSnapshotRequest(
    authorizedRequest({
      "x-forwarded-host": "127.0.0.1:3000",
      "x-forwarded-proto": "http",
    }),
  );

  assert.deepEqual(decision, { allowed: true });
});

test("rejects a non-loopback Host header", () => {
  for (const host of [
    "quota.example.com:3000",
    "192.168.1.40:3000",
    "127.0.0.1.evil.test:3000",
    "",
    "127.0.0.1",
  ]) {
    const decision = evaluateSnapshotRequest(authorizedRequest({ host }));
    assert.equal(decision.allowed, false, `expected ${host} to be refused`);
  }
});

test("rejects a cross-origin browser request", () => {
  for (const origin of [
    "http://evil.test",
    "https://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "null",
  ]) {
    const decision = evaluateSnapshotRequest(authorizedRequest({ origin }));
    assert.deepEqual(
      decision,
      { allowed: false, reason: "cross_origin" },
      `expected ${origin} to be refused`,
    );
  }
});

test("accepts a same-origin browser request", () => {
  const decision = evaluateSnapshotRequest(
    authorizedRequest({ origin: "http://127.0.0.1:3000" }),
  );

  assert.deepEqual(decision, { allowed: true });
});

test("rejects a request with no capability", () => {
  const decision = evaluateSnapshotRequest({
    remoteAddress: "127.0.0.1",
    trustedPeerMarker: MARKER,
    capabilitySecret: SECRET,
    now: NOW,
    header: headersFrom({
      host: "127.0.0.1:3000",
      [TRUSTED_PEER_HEADER]: MARKER,
    }),
  });

  assert.deepEqual(decision, { allowed: false, reason: "missing_capability" });
});

test("rejects an expired capability", () => {
  const capability = mintDashboardCapability(SECRET, NOW, 1_000);
  const decision = evaluateSnapshotRequest({
    ...authorizedRequest({ [CAPABILITY_HEADER]: capability }),
    now: NOW + 1_001,
  });

  assert.deepEqual(decision, { allowed: false, reason: "expired_capability" });
});

test("rejects a capability minted by a different secret", () => {
  const foreign = mintDashboardCapability(createCapabilitySecret(), NOW);
  const decision = evaluateSnapshotRequest(
    authorizedRequest({ [CAPABILITY_HEADER]: foreign }),
  );

  assert.deepEqual(decision, { allowed: false, reason: "invalid_capability" });
});

test("rejects tampered or malformed capabilities", () => {
  const valid = mintDashboardCapability(SECRET, NOW);
  const [prefix, expiry, mac] = valid.split(".");

  const candidates = [
    "",
    "qo1",
    `${prefix}.${expiry}`,
    `${prefix}.${expiry}.${mac}.extra`,
    `qo2.${expiry}.${mac}`,
    `${prefix}.${Number(expiry) + 60_000}.${mac}`,
    `${prefix}.not-a-number.${mac}`,
    `${prefix}.${expiry}.${mac}x`,
  ];

  for (const candidate of candidates) {
    const decision = evaluateSnapshotRequest(
      authorizedRequest({ [CAPABILITY_HEADER]: candidate }),
    );
    assert.equal(
      decision.allowed,
      false,
      `expected ${JSON.stringify(candidate)} to be refused`,
    );
  }
});

test("verifies a freshly minted capability and refuses it after expiry", () => {
  const capability = mintDashboardCapability(SECRET, NOW, 60_000);

  assert.deepEqual(verifyDashboardCapability(SECRET, capability, NOW), {
    allowed: true,
  });
  assert.deepEqual(
    verifyDashboardCapability(SECRET, capability, NOW + 60_000),
    { allowed: false, reason: "expired_capability" },
  );
});

test("the capability endpoint gate ignores capability headers", () => {
  const decision = evaluateTrustedLocalRequest({
    remoteAddress: "127.0.0.1",
    trustedPeerMarker: MARKER,
    capabilitySecret: SECRET,
    now: NOW,
    header: headersFrom({
      host: "localhost:3000",
      [TRUSTED_PEER_HEADER]: MARKER,
    }),
  });

  assert.deepEqual(decision, { allowed: true });
});

test("the capability endpoint gate still refuses remote peers", () => {
  const decision = evaluateTrustedLocalRequest({
    remoteAddress: "10.0.0.8",
    trustedPeerMarker: MARKER,
    capabilitySecret: SECRET,
    now: NOW,
    header: headersFrom({
      host: "localhost:3000",
      [TRUSTED_PEER_HEADER]: MARKER,
    }),
  });

  assert.deepEqual(decision, { allowed: false, reason: "non_loopback_peer" });
});

test("classifies loopback peer addresses across IPv4 and IPv6 forms", () => {
  for (const address of [
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.255",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:0:127.0.0.1",
    "::127.0.0.1",
    "[::1]",
    "::1%lo0",
    " 127.0.0.1 ",
  ]) {
    assert.equal(isLoopbackAddress(address), true, `${address} should be loopback`);
  }
});

test("refuses non-loopback and malformed peer addresses", () => {
  for (const address of [
    "0.0.0.0",
    "192.168.1.40",
    "10.0.0.8",
    "203.0.113.9",
    "::ffff:192.168.1.40",
    "fe80::1",
    "2001:db8::1",
    "127.0.0.1.evil.test",
    "127.0.0.256",
    "127.0.0",
    "localhost",
    "",
    undefined,
    null,
  ]) {
    assert.equal(
      isLoopbackAddress(address),
      false,
      `${String(address)} should not be loopback`,
    );
  }
});

test("treats only localhost and loopback literals as loopback hostnames", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("LOCALHOST"), true);
  assert.equal(isLoopbackHostname("127.0.0.1"), true);
  assert.equal(isLoopbackHostname("::1"), true);
  assert.equal(isLoopbackHostname("localhost.evil.test"), false);
  assert.equal(isLoopbackHostname("0.0.0.0"), false);
  assert.equal(isLoopbackHostname("quota.example.com"), false);
});

test("the verified peer address header is never trusted without the marker", () => {
  // The route reads the peer from a header the trusted server stamps after
  // deleting inbound copies; a client that sets it without the marker fails.
  const decision = evaluateSnapshotRequest({
    remoteAddress: "127.0.0.1",
    trustedPeerMarker: MARKER,
    capabilitySecret: SECRET,
    now: NOW,
    header: headersFrom({
      host: "127.0.0.1:3000",
      [PEER_ADDRESS_HEADER]: "127.0.0.1",
      [CAPABILITY_HEADER]: mintDashboardCapability(SECRET, NOW),
    }),
  });

  assert.deepEqual(decision, {
    allowed: false,
    reason: "untrusted_peer_marker",
  });
});
