// Simulates the cost of a background collection: launches a real isolated
// browser against a QuotaOps-style profile and holds it open, so state 3
// measures what collection actually costs rather than an estimate.
// Synthetic only — no provider login, no credentials.
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

const profileRoot = process.argv[2];
if (!profileRoot) throw new Error("usage: collect-sim.mjs <profile-root>");
await mkdir(profileRoot, { recursive: true });

const context = await chromium.launchPersistentContext(profileRoot, {
  channel: "chrome",
  headless: true,
  chromiumSandbox: true,
  acceptDownloads: false,
  args: ["--disable-extensions"],
});
const page = context.pages()[0] ?? (await context.newPage());
await page.goto("about:blank");
process.stdout.write("collect-sim: browser up\n");
await new Promise(() => {});
