import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import { CollectionCancelledError } from "../collector/browser-session.ts";
import { collectInHiddenDesktop, hiddenDesktopSupported, parseWorkerResult } from "../collector/hidden-desktop.ts";
import type { CollectorAccountConfig } from "../collector/types.ts";

const accounts: CollectorAccountConfig[] = [
  { id: "claude-1", label: "One", provider: "claude", profileDir: "C:/p/1", enabled: true },
  { id: "claude-2", label: "Two", provider: "claude", profileDir: "C:/p/2", enabled: true },
];

function fakeTrampoline(onSpawn: (args: string[], env: NodeJS.ProcessEnv, child: EventEmitter & { stdout: PassThrough; kill: () => boolean; killed: boolean }) => void) {
  return (args: string[], env: NodeJS.ProcessEnv) => {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, {
      stdout: new PassThrough(),
      killed: false,
      kill() { child.killed = true; setImmediate(() => emitter.emit("exit", 1)); return true; },
    });
    setImmediate(() => onSpawn(args, env, child));
    // The runner only uses stdout, kill and exit/error events.
    return child as never;
  };
}

test("hidden-desktop collection is a Windows-only mode", () => {
  assert.equal(hiddenDesktopSupported("win32"), true);
  assert.equal(hiddenDesktopSupported("linux"), false);
  assert.equal(hiddenDesktopSupported("darwin"), false);
});

test("worker results are accepted only with the batch nonce, known ids and known statuses", () => {
  const ok = { id: "claude-1", label: "One", status: "ok", account: null, checkedAt: "2026-11-20T10:00:00.000Z", message: null };
  const raw = (nonce: string, results: unknown[]) => JSON.stringify({ version: 1, nonce, results });
  assert.equal(parseWorkerResult(raw("a".repeat(32), [ok]), "a".repeat(32), accounts).size, 1);
  assert.equal(parseWorkerResult(raw("b".repeat(32), [ok]), "a".repeat(32), accounts).size, 0, "stale result file");
  assert.equal(parseWorkerResult(raw("a".repeat(32), [{ ...ok, id: "other" }]), "a".repeat(32), accounts).size, 0);
  assert.equal(parseWorkerResult(raw("a".repeat(32), [{ ...ok, status: "fabricated" }]), "a".repeat(32), accounts).size, 0);
  assert.equal(parseWorkerResult("not json", "a".repeat(32), accounts).size, 0);
});

test("a completed worker's results are returned per account; missing ones become unavailable", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "quotaops-hidden-"));
  try {
    const results = await collectInHiddenDesktop(accounts, {
      runDir,
      spawnTrampoline: fakeTrampoline(async (args, env, child) => {
        assert.equal(env.ELECTRON_RUN_AS_NODE, "1", "the worker runs on QuotaOps' own Node runtime");
        assert.equal(env.PSModulePath, undefined);
        assert.ok(args.includes("-File") && args.some((a) => a.endsWith("hidden-desktop-run.ps1")));
        const request = JSON.parse(await readFile(join(runDir, "hidden-request.json"), "utf8"));
        assert.deepEqual(request.accountIds, ["claude-1", "claude-2"]);
        await writeFile(join(runDir, "hidden-result.json"), JSON.stringify({
          version: 1,
          nonce: request.nonce,
          results: [{ id: "claude-1", label: "One", status: "ok", account: null, checkedAt: "2026-11-20T10:00:00.000Z", message: null }],
        }));
        child.stdout.write("STARTED 123\r\nEXIT 0\r\n");
        child.emit("exit", 0);
      }),
    });
    assert.deepEqual(results.map((r) => r.status), ["ok", "unavailable"]);
    assert.equal(results[1]?.account, null, "no values are invented for a missing result");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("cancelling (Quit) ends the trampoline, whose job ends the worker and browsers", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "quotaops-hidden-"));
  try {
    const abort = new AbortController();
    let killed = false;
    const running = collectInHiddenDesktop(accounts, {
      runDir,
      signal: abort.signal,
      spawnTrampoline: fakeTrampoline((_args, _env, child) => {
        const kill = child.kill.bind(child);
        child.kill = () => { killed = true; return kill(); };
        setTimeout(() => abort.abort(), 10);
      }),
    });
    await assert.rejects(running, CollectionCancelledError);
    assert.equal(killed, true);
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("the trampoline runs the worker in a kill-on-close job on a separate desktop", async () => {
  const script = await readFile(new URL("../collector/hidden-desktop-run.ps1", import.meta.url), "utf8");
  assert.match(script, /CreateDesktopW\(/);
  assert.match(script, /LimitFlags = 0x2000; \/\/ JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.match(script, /0x00000004u \| 0x08000000u/, "created suspended, joined to the job before it runs");
  assert.doesNotMatch(script, /SwitchDesktop|user-agent|--headless/i, "never shown, browser unchanged");
  assert.doesNotMatch(script, /[^\x00-\x7F]/, "ASCII only for Windows PowerShell 5.1");
  const builder = JSON.parse(await readFile(new URL("../desktop/electron-builder.json", import.meta.url), "utf8"));
  const collector = builder.extraResources.find((entry: { from: string }) => entry.from === "collector");
  assert.ok(collector.filter.includes("hidden-desktop-run.ps1"), "the trampoline must be packaged");
});

test("background collection uses the hidden desktop on Windows unless set to headless", async () => {
  const service = await readFile(new URL("../collector/service.ts", import.meta.url), "utf8");
  assert.match(service, /const hidden = !visible && current\.backgroundCollection !== "headless" && hiddenDesktopSupported\(\);/);
  assert.match(service, /collectInHiddenDesktop\(browserAccounts, \{ signal, runDir: getCollectorRunDir\(\) \}\)/);
});
