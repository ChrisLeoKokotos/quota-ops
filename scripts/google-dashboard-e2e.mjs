// Credential-free Google manual-provider browser E2E.
// Run after npm run build; CI uses an isolated dashboard home.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const home = await mkdtemp(join(tmpdir(), "quotaops-google-e2e-"));
const env = { ...process.env, HOME: home, USERPROFILE: home };
let server = null;
let browser = null;
let output = "";
function startDashboard() {
  return new Promise((resolve, reject) => {
    let settled = false;
    server = spawn(process.execPath,
      ["--experimental-strip-types", "server/dashboard-server.ts", "--production"],
      { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timeout = setTimeout(() => fail(new Error("Dashboard did not become ready")), 90000);
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    }
    server.stdout.on("data", (chunk) => {
      output += String(chunk).slice(0, 2000);
      const match = output.match(/QuotaOps dashboard listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(match[1]);
    });
    server.stderr.on("data", (chunk) => {
      output += String(chunk).slice(0, 2000);
      output = output.slice(-6000);
    });
    server.once("exit", (code) => fail(new Error("Dashboard stopped before ready (exit " + code + ")")));
    server.once("error", fail);
  });
}
try {
  const url = await startDashboard();
  // GitHub-hosted Windows and Ubuntu runners have a Chrome installation.
  // Testing the supported Chrome channel avoids Playwright browser downloads.
  try {
    browser = await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    browser = await chromium.launch({ channel: "msedge", headless: true });
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.getByRole("button", { name: "Add account" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add account" });
  await dialog.getByLabel("Provider").selectOption("google");
  await dialog.getByLabel("Account label").fill("Google AI Pro E2E");
  await dialog.getByLabel("Antigravity model group").fill("Gemini Pro");
  await dialog.locator('input[type="number"]').nth(0).fill("21");
  await dialog.locator('input[type="number"]').nth(1).fill("42");
  await dialog.locator('input[type="datetime-local"]').nth(0).fill("2099-11-20T12:00");
  await dialog.locator('input[type="datetime-local"]').nth(1).fill("2099-11-21T12:00");
  await dialog.getByRole("button", { name: "Add account" }).click();
  const card = page.locator(".account-card").filter({ hasText: "Google AI Pro E2E" });
  await card.getByText("Gemini Pro · 5-hour").waitFor();
  assert.match(await card.innerText(), /manual/);
  assert.match(await card.innerText(), /Gemini Pro · Weekly/);
  assert.doesNotMatch(await card.innerText(), /auto-synced/);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("quotaops:accounts:v2") ?? "[]"));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].provider, "google");
  assert.equal(stored[0].source, "manual");
  assert.deepEqual(stored[0].windows.map((w) => w.usedPercent), [21, 42]);
  await card.getByLabel("New Antigravity model group").fill("Gemini Flash");
  await card.getByRole("button", { name: "Add model group" }).click();
  await card.getByText("Gemini Flash · Weekly").waitFor();
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloaded = page.locator(".account-card").filter({ hasText: "Google AI Pro E2E" });
  await reloaded.getByText("Gemini Flash · Weekly").waitFor();
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem("quotaops:accounts:v2") ?? "[]"));
  assert.equal(after[0].windows.length, 4);
  assert.equal(after[0].source, "manual");
  // Verify the actual dashboard's advisor using isolated synthetic manual readings.
  await page.evaluate(() => {
    const now=Date.now();
    const sample=(id,provider,short,week,age=0)=>({id,label:id,provider,plan:"Test",source:"manual",
      updatedAt:new Date(now-age).toISOString(),windows:[
        {id:"five-hour",label:"5-hour",usedPercent:short,resetAt:new Date(now+14400000).toISOString()},
        {id:"weekly",label:"Weekly",usedPercent:week,resetAt:new Date(now+259200000).toISOString()},
      ]});
    localStorage.setItem("quotaops:accounts:v2",JSON.stringify([
      sample("Advisor-bottleneck","claude",94,0), sample("Advisor-balanced","claude",40,40),
      sample("Advisor-stale","claude",0,0,25*3600000), sample("Advisor-openai","openai",90,90),
    ]));
  });
  await page.reload({waitUntil:"domcontentloaded"});
  const advisor=page.getByRole("region",{name:"Smart Account Advisor"});
  const recommendation=advisor.getByRole("status");
  await recommendation.getByText("Advisor-balanced",{exact:true}).waitFor();
  assert.match(await advisor.innerText(),/Advisor-stale · Not recommended/);
  assert.match(await advisor.innerText(),/Advisor-bottleneck · Low headroom/);
  await advisor.getByLabel("Provider").selectOption("openai");
  await recommendation.getByText("No reliable recommendation",{exact:true}).waitFor();
  await advisor.getByLabel("Task").selectOption("quick");
  await recommendation.getByText("Advisor-openai",{exact:true}).waitFor();
  assert.equal(await page.locator(".metric-highlight strong").innerText(),"Advisor-openai");
  await advisor.getByLabel("Task").selectOption("heavy");
  await recommendation.getByText("No reliable recommendation",{exact:true}).waitFor();
  console.log("PASS: Google manual dashboard and Smart Account Advisor provider/task/freshness E2E (synthetic, no credentials).");
} finally {
  await browser?.close().catch(() => undefined);
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await rm(home, { recursive: true, force: true });
}
