// Owner-run validation of QuotaOps collection against YOUR OWN Claude
// accounts (v0.2.0 release gate). Run it yourself, on your machine.
//
// What it does: for each enabled Claude account in ~/.quotaops/collector.json
// it runs the real collector once per round, in the mode(s) you choose, and
// records ONLY: account alias, mode, time, status, whether usage values were
// returned (yes/no), duration. It never records or prints usage numbers,
// emails, cookies, tokens, page text or profile contents, and it never
// clicks, solves or bypasses a provider verification.
//
// Usage (QuotaOps must be closed first):
//   node --experimental-strip-types scripts/claude-account-validation.mjs --mode background
//   node --experimental-strip-types scripts/claude-account-validation.mjs --mode visible --i-accept-visible-windows
//   ... --mode both --rounds 4 --interval-min 30
//
// Modes: background = headless, exactly what scheduled collection does;
//        visible = ordinary browser windows (they take focus; do not type).
// Report: ~/.quotaops/validation/claude-validation-<time>.json and .md,
// readable only by you. Share it only if you choose to.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const mode = opt("--mode", "background");
const rounds = Number(opt("--rounds", "1"));
const intervalMin = Number(opt("--interval-min", "30"));
const showLabels = argv.includes("--show-labels");
if (!["background", "visible", "both"].includes(mode)) throw new Error("--mode background|visible|both");
if (mode !== "background" && !argv.includes("--i-accept-visible-windows")) {
  throw new Error("Visible mode opens browser windows that take focus. Re-run with --i-accept-visible-windows.");
}
// Gentle on the provider: few rounds, long gaps.
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 12) throw new Error("--rounds 1..12");
if (rounds > 1 && !(intervalMin >= 10)) throw new Error("--interval-min must be at least 10 between rounds");

const portBusy = await new Promise((done) => {
  const socket = connect({ host: "127.0.0.1", port: 4317 });
  socket.setTimeout(800);
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => { socket.destroy(); done(false); });
  socket.once("timeout", () => { socket.destroy(); done(true); });
});
if (portBusy) {
  throw new Error("QuotaOps (or another collector) is running. Quit it from the tray first: two programs must not open the same browser profile.");
}

const { loadCollectorConfig } = await import("../collector/config.ts");
const { collectProviderUsage } = await import("../collector/provider.ts");
const config = await loadCollectorConfig();
const accounts = config.accounts.filter((account) => account.enabled && account.provider === "claude");
if (accounts.length === 0) throw new Error("No enabled Claude accounts in ~/.quotaops/collector.json.");
const alias = new Map(accounts.map((account, index) => [account.id, showLabels ? account.label : `account-${index + 1}`]));
const modes = mode === "both" ? ["background", "visible"] : [mode];

const started = new Date();
const records = [];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
process.stdout.write(`Validating ${accounts.length} Claude account(s), mode=${mode}, rounds=${rounds}` +
  (rounds > 1 ? `, every ${intervalMin} min` : "") + ".\n");

for (let round = 1; round <= rounds; round++) {
  for (const presentation of modes) {
    for (const account of accounts) {
      const t0 = Date.now();
      let status = "error";
      let hasValues = false;
      try {
        const result = await collectProviderUsage(account, { visible: presentation === "visible" });
        status = result.status;
        hasValues = result.account !== null;
      } catch {
        status = "error";
      }
      const record = {
        round,
        at: new Date().toISOString(),
        account: alias.get(account.id),
        mode: presentation,
        status,
        hasValues,
        durationMs: Date.now() - t0,
      };
      records.push(record);
      process.stdout.write(`round ${round}  ${presentation.padEnd(10)}  ${record.account.padEnd(12)}  ${status.padEnd(22)}  values=${hasValues ? "yes" : "no "}  ${record.durationMs} ms\n`);
    }
  }
  if (round < rounds) {
    process.stdout.write(`Waiting ${intervalMin} min before round ${round + 1} (Ctrl+C keeps the report of finished rounds only if you re-run).\n`);
    await sleep(intervalMin * 60_000);
  }
}

const summary = {};
for (const record of records) {
  const key = `${record.mode}:${record.status}`;
  summary[key] = (summary[key] ?? 0) + 1;
}
const dir = join(homedir(), ".quotaops", "validation");
if (!existsSync(dir)) await mkdir(dir, { recursive: true, mode: 0o700 });
const stamp = started.toISOString().replace(/[:.]/g, "-");
const report = {
  version: 1,
  kind: "quotaops-claude-account-validation",
  started: started.toISOString(),
  finished: new Date().toISOString(),
  mode, rounds, intervalMin,
  accounts: accounts.length,
  summary,
  records,
};
await writeFile(join(dir, `claude-validation-${stamp}.json`), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const table = [
  "| round | time (UTC) | account | mode | status | values | ms |",
  "|---|---|---|---|---|---|---|",
  ...records.map((r) => `| ${r.round} | ${r.at} | ${r.account} | ${r.mode} | ${r.status} | ${r.hasValues ? "yes" : "no"} | ${r.durationMs} |`),
].join("\n");
await writeFile(join(dir, `claude-validation-${stamp}.md`),
  `# QuotaOps Claude validation ${started.toISOString()}\n\nMode: ${mode}; rounds: ${rounds}.\n\n` +
  `Summary: ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(", ")}\n\n${table}\n`, { mode: 0o600 });
process.stdout.write(`\nSummary: ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(", ")}\n`);
process.stdout.write(`Report: ${join(dir, `claude-validation-${stamp}.md`)} (statuses only; no usage numbers or account data).\n`);
