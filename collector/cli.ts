import { collectProviderUsage, openProviderLogin } from "./provider.ts";
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
      "  collect <id>",
      "  tokens",
      "  tokens-auto <enable|disable|status>",
      "  enable <id> [id...]",
      "  disable <id> [id...]",
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
      (providerArg !== "claude" && providerArg !== "openai") ||
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
    const [action] = args;
    if (!action || !["enable", "disable", "status"].includes(action)) usage();
    const config = await loadCollectorConfig();
    if (action === "status") {
      process.stdout.write(`Background token scanning: ${config.tokenAnalyticsEnabled ? "enabled" : "disabled"}.\\n`);
      return;
    }
    await saveCollectorConfig({ ...config, tokenAnalyticsEnabled: action === "enable" });
    process.stdout.write(`Background token scanning ${action === "enable" ? "enabled" : "disabled"}. Restart or wait for the next collector refresh.\\n`);
    return;
  }

  if (command === "tokens") {
    const analytics = await collectLocalTokenAnalytics();
    process.stdout.write(JSON.stringify(analytics, null, 2) + "\n");
    return;
  }

  if (command === "collect") {
    const [id] = args;
    if (!id) usage();

    const config = await loadCollectorConfig();
    const account = config.accounts.find((item) => item.id === id);
    if (!account) {
      throw new Error(`Unknown account id: ${id}`);
    }

    const result = await collectProviderUsage(account);
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
