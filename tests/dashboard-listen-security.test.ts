import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Configuration checks only. The boundary's *behaviour* is covered by
 * `tests/dashboard-boundary.test.ts`, which drives real TCP connections.
 *
 * Earlier revisions of this file asserted the controls by regex-matching
 * `server/dashboard-server.ts` as text. Each of those would have passed with
 * the control it named fully removed, so they are gone rather than kept as
 * reassurance.
 */

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

test("the trusted server has no configurable listen address", () => {
  // The host is a constant rather than an input: a configurable host would
  // move the boundary decision out of the code and into deployment.
  assert.match(dashboardServer, /const HOST = "127\.0\.0\.1"/);

  const listenCalls = dashboardServer.match(/^.*\.listen\(.*$/gm) ?? [];
  assert.equal(listenCalls.length, 1, "expected exactly one listen call");
  assert.match(
    listenCalls[0] ?? "",
    /\.listen\([^,]+, HOST\b/,
    "the listen call must bind the loopback constant",
  );
});

test("the server verifies the address it actually bound", () => {
  // Checking configuration is not checking the socket. This assertion exists
  // because an earlier guard inspected HOSTNAME, which the server never
  // reads, and so proved nothing about what was bound.
  assert.match(dashboardServer, /boundLoopbackPort\(server\)/);
  assert.match(dashboardServer, /server\.address\(\)/);
});

test("the dashboard port is OS-allocated with no fallback to 3000", () => {
  // Risk C (C2). A silent fallback would restore the fixed port that a
  // preconfigured relay targets, which is the whole point of the change.
  assert.match(dashboardServer, /if \(!raw\) return 0;/);

  // Comments may discuss 3000; code must not default to it. Strip comments
  // first so the assertion tests behaviour rather than prose.
  const code = dashboardServer
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.equal(
    /\b3000\b/.test(code),
    false,
    "the trusted server must not default to a fixed dashboard port",
  );
});
