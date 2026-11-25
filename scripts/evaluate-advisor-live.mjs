// Explicit local, read-only observer of the existing collector. No writes,
// provider calls, account switching, or raw snapshot/identifier output.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { evaluateAdvisorObservations } from "../lib/advisor-evaluation.ts";

const args = process.argv.slice(2);
const minutes = Number(args[2]);
const task = args[4];
if (args.length !== 5 || args[0] !== "--observe-local" || args[1] !== "--minutes" ||
    args[3] !== "--task" || !Number.isInteger(minutes) || minutes < 15 || minutes > 240 ||
    !["quick", "coding", "heavy"].includes(task)) {
  process.stderr.write("Usage: node --experimental-strip-types scripts/evaluate-advisor-live.mjs --observe-local --minutes 90 --task coding\n");
  process.exit(1);
}
const identities = new Map();
const frames = [];
let failures = 0;
let token;
try {
  token = (await readFile(join(homedir(), ".quotaops", "collector.token"), "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("invalid token");
} catch {
  process.stderr.write("Collector credential unavailable. Start the existing QuotaOps app; no files were changed.\n");
  process.exit(1);
}

async function sample() {
  const response = await fetch("http://127.0.0.1:4317/snapshot", {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    redirect: "error", signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.body) throw new Error("snapshot unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("snapshot too large");
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (payload.version !== 1 || !Array.isArray(payload.accounts) || payload.accounts.length > 100) throw new Error("snapshot shape");
  const accounts = [];
  for (const result of payload.accounts) {
    const a = result?.account;
    if (result?.status !== "ok" || !a || a.id !== result.id || typeof a.id !== "string" ||
        a.id.length > 64 || !["claude","openai","google"].includes(a.provider) ||
        typeof a.plan !== "string" || a.plan.length > 80 || typeof a.updatedAt !== "string" ||
        !Array.isArray(a.windows) || !a.windows.length || a.windows.length > 64 ||
        !a.windows.every(w => w && typeof w.id === "string" && w.id.length <= 128 &&
          typeof w.usedPercent === "number" && (w.resetAt === null || typeof w.resetAt === "string"))) continue;
    if (!identities.has(a.id)) {
      if (identities.size >= 100) continue;
      identities.set(a.id, "local-" + (identities.size + 1));
    }
    // Only operational quota metadata in memory. Do not keep labels, email,
    // token analytics, prompts, cookies or any raw provider/account identity.
    accounts.push({ id: identities.get(a.id), label: "", provider: a.provider, plan: a.plan,
      source: "collector", updatedAt: a.updatedAt,
      windows: a.windows.map(w => ({ id: w.id, label: "", usedPercent: w.usedPercent, resetAt: w.resetAt })) });
  }
  return accounts;
}

const until = Date.now() + minutes * 60_000;
let stopped = false;
process.once("SIGINT", () => { stopped = true; });
process.stdout.write("Observing existing loopback snapshots only. No refreshes are triggered. Ctrl+C ends observation and reports aggregates.\n");
while (!stopped && Date.now() < until) {
  let accounts = [];
  try { accounts = await sample(); } catch { failures++; }
  frames.push({ capturedAt: Date.now(), accounts });
  if (!stopped && Date.now() < until) await sleep(Math.min(30_000, until - Date.now()));
}
const results = evaluateAdvisorObservations(frames, task);
console.log(JSON.stringify({ snapshotPolls: frames.length, failedPolls: failures, ...results,
  conclusion: results.matchedOutcomes ? "Observational holdout; not causal session performance." : "Insufficient comparable outcomes; no accuracy claim." }, null, 2));
