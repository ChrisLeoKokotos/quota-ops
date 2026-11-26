import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext } from "playwright-core";

if (process.platform !== "win32") {
  throw new Error("This browser lifecycle smoke test must run on Windows.");
}

const directory = await mkdtemp(join(tmpdir(), "quotaops-browser-smoke-"));
let context: BrowserContext | null = null;
let launchedChannel: "chrome" | "msedge" | null = null;
try {
  for (const channel of ["chrome", "msedge"] as const) {
    try {
      context = await chromium.launchPersistentContext(directory, {
        channel,
        headless: true,
        chromiumSandbox: true,
        acceptDownloads: false,
        args: ["--disable-extensions"],
      });
      launchedChannel = channel;
      break;
    } catch {
      // Either installed supported browser is acceptable for this smoke test.
    }
  }

  if (!context) throw new Error("Neither Chrome nor Edge launched using private browser transport.");
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("about:blank");
  assert.equal(page.url(), "about:blank");
  await context.close();
  context = null;
  assert.equal(page.isClosed(), true);
  process.stdout.write(`PASS: ${launchedChannel} synthetic isolated browser opened and closed.\n`);
} finally {
  await context?.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}
