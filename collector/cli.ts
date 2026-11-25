import { collectProviderUsage, openProviderLogin } from "./provider.ts";
import { mergeGoogleAnalytics } from "./google-analytics.ts";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { collectLocalTokenAnalytics } from "./token-analytics.ts";
import {
  bootstrapFiveAccounts,
  createAccountConfig,
  loadCollectorConfig,
  saveCollectorConfig,
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

    const config = await loadCollectorConfig();
    const account = createAccountConfig(id, label, providerArg);
    const existing = config.accounts.findIndex((item) => item.id === account.id);
    const accounts =
      existing >= 0
        ? config.accounts.map((item, index) =>
            index === existing ? account : item,
          )
        : [...config.accounts, account];

    await saveCollectorConfig({ ...config, accounts });
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

    const config = await loadCollectorConfig();
    const unknown = args.filter(
      (id) => !config.accounts.some((account) => account.id === id),
    );
    if (unknown.length > 0) {
      throw new Error(`Unknown account id(s): ${unknown.join(", ")}`);
    }

    const enabled = command === "enable";
    const ids = new Set(args);
    const accounts = config.accounts.map((account) =>
      ids.has(account.id) ? { ...account, enabled } : account,
    );

    await saveCollectorConfig({ ...config, accounts });
    process.stdout.write(
      `${enabled ? "Enabled" : "Disabled"}: ${args.join(", ")}.\n`,
    );
    return;
  }

  if (command === "tokens-auto") {
    const [action, scope = "all"] = args;
    if (!action || !["enable", "disable", "status"].includes(action)) usage();
    if (!["claude-code", "codex", "google-antigravity", "all"].includes(scope)) usage();

    const config = await loadCollectorConfig();
    const consent = config.tokenAnalyticsSources;

    if (action === "status") {
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
    const next = {
      claudeCode: scope === "codex" || scope === "google-antigravity" ? consent.claudeCode : value,
      codex: scope === "claude-code" || scope === "google-antigravity" ? consent.codex : value,
      // Google is explicitly opt-in; "all" can disable it but never silently enable it.
      googleAntigravity: scope === "google-antigravity" ? value
        : scope === "all" && action === "disable" ? false
        : consent.googleAntigravity === true,
    };

    const { googleTokenConsentEpoch: previousEpoch, ...rest } = config;
    await saveCollectorConfig({
      ...rest,
      tokenAnalyticsEnabled: next.claudeCode || next.codex || next.googleAntigravity,
      tokenAnalyticsSources: next,
      ...(next.googleAntigravity ? {
        googleTokenConsentEpoch: consent.googleAntigravity === true && previousEpoch
          ? previousEpoch : randomUUID(),
      } : {}),
    });
    process.stdout.write(
      `Background token scanning updated. Claude Code: ${next.claudeCode ? "enabled" : "disabled"}; ` +
        `Codex: ${next.codex ? "enabled" : "disabled"}; Antigravity: ${next.googleAntigravity ? "enabled" : "disabled"}. ` +
        "The running collector observes config changes; restart if needed. An in-flight read can take a short time to stop.\n",
    );
    return;
  }

  if (command === "tokens") {
    const config = await loadCollectorConfig();
    const consent = config.tokenAnalyticsSources;

    if (!consent.claudeCode && !consent.codex && consent.googleAntigravity !== true) {
      process.stdout.write(
        "No session history source is enabled, so nothing was read.\n" +
          "Enable one explicitly, for example: collector:setup -- tokens-auto enable claude-code\n",
      );
      return;
    }

    const analytics = await mergeGoogleAnalytics(await collectLocalTokenAnalytics(consent),config.accounts,consent.googleAntigravity === true);
    process.stdout.write(JSON.stringify(analytics, null, 2) + "\n");
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
