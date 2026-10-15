import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

const dashboardServer = await readFile(
  new URL("../server/dashboard-server.ts", import.meta.url),
  "utf8",
);

test("dashboard commands run through the trusted loopback server", () => {
  for (const script of ["dev", "start"]) {
    const command = pkg.scripts[script] ?? "";
    assert.equal(
      command.includes("server/dashboard-server.ts"),
      true,
      `${script} must start the trusted server, not a bare Next.js listener`,
    );
    assert.equal(
      command.includes("next dev") || command.includes("next start"),
      false,
      `${script} must not bypass the QO-SEC-01 peer enforcement layer`,
    );
  }
});

test("the trusted server binds loopback and has no configurable host", () => {
  assert.match(dashboardServer, /const HOST = "127\.0\.0\.1"/);
  assert.match(dashboardServer, /server\.listen\(port, HOST/);
  assert.equal(dashboardServer.includes("0.0.0.0"), false);
});

test("the trusted server refuses a non-loopback HOSTNAME override", () => {
  assert.match(dashboardServer, /assertLoopbackOnlyConfiguration/);
  assert.match(dashboardServer, /Refusing to start: HOSTNAME=/);
});

test("the trusted server refuses proxied requests before Next.js sees them", () => {
  assert.match(dashboardServer, /isProxiedRequest\(request\)/);
  assert.match(dashboardServer, /"forwarded_request"/);
});

test("the trusted server destroys non-loopback connections", () => {
  assert.match(dashboardServer, /isLoopbackAddress\(socket\.remoteAddress\)/);
  assert.match(dashboardServer, /socket\.destroy\(\)/);
});

test("the trusted server strips spoofable trust headers before stamping", () => {
  const stripIndex = dashboardServer.indexOf("stripSpoofableHeaders(request)");
  const stampIndex = dashboardServer.indexOf(
    "request.headers[TRUSTED_PEER_HEADER] =",
  );

  assert.notEqual(stripIndex, -1);
  assert.notEqual(stampIndex, -1);
  assert.equal(
    stripIndex < stampIndex,
    true,
    "inbound copies must be deleted before the trusted marker is applied",
  );
});
