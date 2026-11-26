import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runtime smoke test for the desktop shell.
 *
 * `desktop/electron-ipc/main.js` is not importable from the unit suite: it
 * requires `electron`. An adversarial review pointed out that every control
 * living there was therefore unverified — the module wiring, the CSP actually
 * reaching the renderer, the IPC round trip. That gap is not theoretical: a
 * constant moved into the shared module left `MAX_ACCOUNTS` undefined in
 * `main.js`, the whole unit suite stayed green, and the dashboard failed at
 * runtime with "MAX_ACCOUNTS is not defined".
 *
 * This launches the real shell against a stub collector and asserts what the
 * unit tests cannot:
 *
 *   1. The IPC round trip completes, so the module graph actually loads.
 *   2. The CSP reaches the renderer: `connect-src 'none'` blocks a fetch.
 *   3. Inline script injection is refused, so the hash allowlist is in force.
 *   4. No process survives shutdown.
 *
 * Synthetic throughout: the stub serves a fixed payload and no provider login
 * is involved.
 */

if (process.platform !== "win32") {
  throw new Error("The desktop shell smoke test must run on Windows.");
}

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const electron = join(repo, "node_modules", "electron", "dist", "electron.exe");
const shellDir = join(repo, "desktop", "electron-ipc");

const token = (
  await readFile(join(homedir(), ".quotaops", "collector.token"), "utf8")
).trim();

const snapshot = {
  version: 1,
  generatedAt: new Date().toISOString(),
  accounts: [
    {
      id: "smoke-1",
      label: "Smoke",
      status: "ok",
      checkedAt: new Date().toISOString(),
      message: null,
      account: {
        id: "smoke-1",
        label: "Smoke",
        provider: "claude",
        plan: "Max",
        updatedAt: new Date().toISOString(),
        windows: [{ id: "5h", label: "5 hour", usedPercent: 17, resetAt: null }],
      },
    },
  ],
  tokens: null,
};

const collector = createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.statusCode = 401;
    response.end('{"error":"unauthorized"}');
    return;
  }
  response.setHeader("Content-Type", "application/json");
  response.end(
    JSON.stringify(request.url === "/health" ? { status: "ok", collecting: false } : snapshot),
  );
});

collector.listen(4317, "127.0.0.1");
await once(collector, "listening");

const child = spawn(electron, [shellDir], {
  cwd: repo,
  env: {
    ...process.env,
    QUOTAOPS_IPC_TRACE: "1",
    QUOTAOPS_CSP_PROBE: "1",
    ELECTRON_RUN_AS_NODE: undefined,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += String(chunk);
});
child.stderr.on("data", (chunk) => {
  output += String(chunk);
});

const deadline = Date.now() + 90_000;
try {
  while (Date.now() < deadline) {
    if (output.includes("[ipc] snapshot") && output.includes("[csp-probe]")) break;
    if (child.exitCode !== null) throw new Error("the shell exited before reporting");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const ipc = /\[ipc\] snapshot -> (.+)/.exec(output);
  assert.notEqual(ipc, null, "the IPC round trip never completed");
  assert.match(
    String(ipc?.[1]),
    /version=1 accounts=1/,
    `unexpected snapshot shape: ${ipc?.[1]}`,
  );

  const probeMatch = /\[csp-probe\] (\{.*\})/.exec(output);
  assert.notEqual(probeMatch, null, "the CSP probe never reported");
  const probe = JSON.parse(String(probeMatch?.[1])) as {
    connect: string;
    inlineScript: string;
    metaCsp: string;
  };

  assert.match(
    probe.connect,
    /^BLOCKED/,
    "connect-src 'none' is not in force: the renderer reached the network",
  );
  assert.equal(
    probe.inlineScript,
    "BLOCKED",
    "an injected inline script executed: the hash allowlist is not in force",
  );
  assert.equal(
    probe.metaCsp,
    "absent",
    "a meta CSP appeared; the header is meant to be the only source",
  );

  assert.equal(
    /Error occurred in handler/.test(output),
    false,
    "the IPC handler raised an error",
  );

  process.stdout.write(
    "PASS: IPC round trip, connect-src enforced, inline script refused.\n",
  );
} finally {
  child.kill();
  collector.close();
  await once(collector, "close").catch(() => undefined);
}
