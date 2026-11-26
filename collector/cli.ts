import { collectProviderUsage, openProviderLogin } from "./provider.ts";
import { mergeGoogleAnalytics } from "./google-analytics.ts";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { collectLocalTokenAnalytics, tokenScanPending } from "./token-analytics.ts";
import { formatReconcileReport, reconcile } from "./token-reconcile.ts";
import { getCollectorTokenPath, getTokenLedgerPath } from "./paths.ts";
import { readFile, rm } from "node:fs/promises";
import {
  bootstrapFiveAccounts,
  createAccountConfig,
  loadCollectorConfig,
  updateCollectorConfig,
  withCollectorConfig,
  tokenConsentKey,
} from "./config.ts";
import {
  ensureCollectorHomeSecurity,
  getOrCreateCollectorToken,
  rotateCollectorToken,
} from "./security.ts";

function usage(): never {
  process.stderr.write(
    [
      "QuotaOps local collector",
      "",
      "Commands:",
      "  bootstrap-five",
      "  list",
      "  add <provider> <id> <label>",
      "  login <id>",
      "  collect <id> [--visible]",
      "  tokens",
      "  tokens-auto <enable|disable|status> [claude-code|codex|google-antigravity|all]",
      "  tokens-ledger <enable|disable|status>  (opt-in lifetime usage ledger; disable deletes it)",
      "  tokens-reconcile [--show-values] [--json]  (independent check of the token totals)",
      "  enable <id> [id...]",
      "  disable <id> [id...]",
      "  google-hook <id>  (print Antigravity setup command)",
      "  security-check",
      "  rotate-token",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (command === "bootstrap-five") {
    const config = await bootstrapFiveAccounts();
    process.stdout.write(
      `Configured ${config.accounts.length} local account profiles.\n`,
    );
    return;
  }

  if (command === "list") {
    const config = await loadCollectorConfig();
    for (const account of config.accounts) {
      process.stdout.write(
        `${account.id}\t${account.provider}\t${account.label}\t${account.enabled ? "enabled" : "disabled"}\t${account.profileDir}\n`,
      );
    }
    return;
  }

  if (command === "add") {
    const [providerArg, id, ...labelParts] = args;
    const label = labelParts.join(" ");
    if (
      (providerArg !== "claude" && providerArg !== "openai" && providerArg !== "google") ||
      !id ||
      !label
    ) {
      usage();
    }

    const account = createAccountConfig(id, label, providerArg);
    await updateCollectorConfig(config => {
      const existing = config.accounts.findIndex(item => item.id === account.id);
      const accounts = existing >= 0
        ? config.accounts.map((item, index) => index === existing ? account : item)
        : [...config.accounts, account];
      return { ...config, accounts };
    });
    process.stdout.write(`Configured ${account.label}.\n`);
    return;
  }

  if (command === "google-hook") {
    const [id]=args;
    const config=await loadCollectorConfig();
    if(!id || args.length!==1 || !config.accounts.some(a=>a.id===id&&a.provider==="google"))usage();
    const hook=fileURLToPath(new URL("./google-hook.ts",import.meta.url));
    process.stdout.write(
      "In your signed-in Antigravity CLI configure this command once:\n"+
      `/statusline node --experimental-strip-types "${hook}" ${id}\n`+
      "This replaces any existing custom statusline; preserve it first.\n"+
      "Events arrive while the CLI runs, not when the CLI is closed.\n"
    );
    return;
  }

  if (command === "security-check") {
    await ensureCollectorHomeSecurity();
    await getOrCreateCollectorToken();
    const config = await loadCollectorConfig();
    process.stdout.write(
      `Security check passed for ${config.accounts.length} configured account profile(s).\n`,
    );
    return;
  }

  if (command === "rotate-token") {
    await rotateCollectorToken();
    process.stdout.write(
      "Collector token rotated. Restart the collector and QuotaOps server before continuing.\n",
    );
    return;
  }

  if (command === "enable" || command === "disable") {
    if (args.length === 0) usage();

    const enabled = command === "enable";
    const ids = new Set(args);
    await updateCollectorConfig(config => {
      const unknown = args.filter(id => !config.accounts.some(account => account.id === id));
      if (unknown.length > 0) throw new Error(`Unknown account id(s): ${unknown.join(", ")}`);
      return { ...config, accounts: config.accounts.map(account =>
        ids.has(account.id) ? { ...account, enabled } : account) };
    });
    process.stdout.write(
      `${enabled ? "Enabled" : "Disabled"}: ${args.join(", ")}.\n`,
    );
    return;
  }

  if (command === "tokens-auto") {
    const [action, scope = "all"] = args;
    if (!action || !["enable", "disable", "status"].includes(action)) usage();
    if (!["claude-code", "codex", "google-antigravity", "all"].includes(scope)) usage();

    if (action === "status") {
      const config = await loadCollectorConfig();
      const consent = config.tokenAnalyticsSources;
      process.stdout.write(
        `Background token scanning: ${config.tokenAnalyticsEnabled ? "enabled" : "disabled"}.\n` +
          `  Claude Code history: ${consent.claudeCode ? "enabled" : "disabled"}.\n` +
          `  Codex history: ${consent.codex ? "enabled" : "disabled"}.\n` +
          `  Antigravity numeric counters: ${consent.googleAntigravity === true ? "enabled" : "disabled"}.\n`,
      );
      return;
    }

    // Each source carries its own consent; enabling one never enables the other.
    const value = action === "enable";
    const updated = await updateCollectorConfig(config => {
      const consent = config.tokenAnalyticsSources;
      const next = {
        claudeCode: scope === "codex" || scope === "google-antigravity" ? consent.claudeCode : value,
        codex: scope === "claude-code" || scope === "google-antigravity" ? consent.codex : value,
        // Google is explicitly opt-in; "all" can disable it but never silently enable it.
        googleAntigravity: scope === "google-antigravity" ? value
          : scope === "all" && action === "disable" ? false
          : consent.googleAntigravity === true,
      };

      const { googleTokenConsentEpoch: previousEpoch, ...rest } = config;
      return {
        ...rest,
        tokenAnalyticsEnabled: next.claudeCode || next.codex || next.googleAntigravity,
        tokenAnalyticsSources: next,
        tokenConsentRevision: randomUUID(),
        ...(next.googleAntigravity ? {
          googleTokenConsentEpoch: consent.googleAntigravity === true && previousEpoch
            ? previousEpoch : randomUUID(),
        } : {}),
      };
    });
    const next = updated.tokenAnalyticsSources;
    process.stdout.write(
      `Background token scanning updated. Claude Code: ${next.claudeCode ? "enabled" : "disabled"}; ` +
        `Codex: ${next.codex ? "enabled" : "disabled"}; Antigravity: ${next.googleAntigravity ? "enabled" : "disabled"}. ` +
        "The running collector observes config changes; restart if needed. An in-flight read can take a short time to stop.\n",
    );
    return;
  }

  if (command === "tokens-ledger") {
    const [action] = args;
    if (!action || !["enable", "disable", "status"].includes(action) || args.length !== 1) usage();
    if (action === "status") {
      const config = await loadCollectorConfig();
      const exists = await readFile(getTokenLedgerPath()).then(() => true, () => false);
      process.stdout.write(
        `Usage ledger: ${config.tokenLedger === true ? "on" : "off"}; file ${exists ? "present" : "absent"}.\n` +
          "It keeps numeric usage records (no content) so lifetime totals survive deleted session files.\n",
      );
      return;
    }
    const on = action === "enable";
    await updateCollectorConfig((current) => {
      if (on && !current.tokenAnalyticsEnabled) {
        throw new Error("Turn on token analytics for a source first (tokens-auto enable claude-code); the ledger only records consented sources.");
      }
      const { tokenLedger: _previous, ...rest } = current;
      return on ? { ...rest, tokenLedger: true } : rest;
    });
    // Off: delete the stored records now. The collector writes to the ledger
    // only inside the configuration lock after re-reading `tokenLedger`, so
    // once the flag is off no later write can recreate the file.
    if (!on) await rm(getTokenLedgerPath(), { force: true });
    process.stdout.write(on
      ? "Usage ledger on. From the next scan, QuotaOps keeps numeric usage records so lifetime totals survive deleted session files.\n"
      : "Usage ledger off; its file was deleted. Totals again cover only the session files on this PC.\n");
    return;
  }

  if (command === "tokens-reconcile") {
    const flags = new Set(args);
    if ([...flags].some((flag) => flag !== "--show-values" && flag !== "--json")) usage();
    const config = await loadCollectorConfig();
    const consent = config.tokenAnalyticsSources;
    if (!config.tokenAnalyticsEnabled || (!consent.claudeCode && !consent.codex)) {
      process.stdout.write("No Claude Code or Codex source is enabled, so nothing was read.\n");
      return;
    }
    // The running collector's snapshot, if it is up (loopback, local token).
    let snapshot: { tokens?: unknown } | null = null;
    try {
      const token = (await readFile(getCollectorTokenPath(), "utf8")).trim();
      const response = await fetch(`http://127.0.0.1:${config.port}/snapshot`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
      if (response.ok) snapshot = await response.json() as { tokens?: unknown };
    } catch {
      snapshot = null;
    }
    const report = await reconcile({ claudeCode: consent.claudeCode, codex: consent.codex }, snapshot);
    await withCollectorConfig((latest) => {
      if (tokenConsentKey(latest) !== tokenConsentKey(config)) throw new Error("Consent changed during the check; nothing printed.");
      if (flags.has("--json")) {
        const hide = !flags.has("--show-values");
        const rows = report.rows.map((row) => hide
          ? { metric: row.metric, status: row.status, relativeDifference: row.relativeDifference }
          : row);
        process.stdout.write(JSON.stringify({ ...report, rows, valuesHidden: hide, sources: hide ? Object.fromEntries(
          Object.entries(report.sources).map(([key, value]) => [key, value ? { ...value, totals: undefined } : null])) : report.sources }, null, 2) + "\n");
      } else {
        process.stdout.write(formatReconcileReport(report, flags.has("--show-values")));
      }
    });
    return;
  }

  if (command === "tokens") {
    const config = await loadCollectorConfig();
    const consent = config.tokenAnalyticsSources;

    if (!config.tokenAnalyticsEnabled || (!consent.claudeCode && !consent.codex && consent.googleAntigravity !== true)) {
      process.stdout.write(
        "No session history source is enabled, so nothing was read.\n" +
          "Enable one explicitly, for example: collector:setup -- tokens-auto enable claude-code\n",
      );
      return;
    }

    // A one-off process starts with empty caches: keep reading until every
    // file is covered (bounded), instead of printing a first partial pass.
    let local = await collectLocalTokenAnalytics(consent);
    for (let pass = 1; tokenScanPending() && pass < 50; pass++) local = await collectLocalTokenAnalytics(consent);
    const analytics = await mergeGoogleAnalytics(local,config.accounts,consent.googleAntigravity === true);
    await withCollectorConfig(latest => {
      if (tokenConsentKey(latest) !== tokenConsentKey(config)) throw new Error("Consent changed during scan; no token results published.");
      // Queue output under the consent lock, without letting a blocked stdout
      // pipe hold configuration mutations indefinitely.
      process.stdout.write(JSON.stringify(analytics, null, 2) + "\n");
    });
    return;
  }

  if (command === "collect") {
    const [id, ...flags] = args;
    if (!id || flags.some((flag) => flag !== "--visible") ||
        flags.filter((flag) => flag === "--visible").length > 1) usage();

    const config = await loadCollectorConfig();
    const account = config.accounts.find((item) => item.id === id);
    if (!account) {
      throw new Error(`Unknown account id: ${id}`);
    }

    // Visible mode is explicit and never runs during background collection.
    // No credentials, cookies or browser profile files are exported.
    const result = await collectProviderUsage(account, {
      visible: flags.includes("--visible"),
    });
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  if (command === "login") {
    const [id] = args;
    if (!id) usage();

    const config = await loadCollectorConfig();
    const account = config.accounts.find((item) => item.id === id);
    if (!account) {
      throw new Error(`Unknown account id: ${id}`);
    }

    await openProviderLogin(account);
    return;
  }

  usage();
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
