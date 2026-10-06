import { openClaudeLogin } from "./browser.ts";
import {
  bootstrapFiveAccounts,
  createAccountConfig,
  loadCollectorConfig,
  saveCollectorConfig,
} from "./config.ts";

function usage(): never {
  process.stderr.write(
    [
      "QuotaOps local collector",
      "",
      "Commands:",
      "  bootstrap-five",
      "  list",
      "  add <id> <label>",
      "  login <id>",
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
        `${account.id}\t${account.label}\t${account.profileDir}\n`,
      );
    }
    return;
  }

  if (command === "add") {
    const [id, ...labelParts] = args;
    const label = labelParts.join(" ");
    if (!id || !label) usage();

    const config = await loadCollectorConfig();
    const account = createAccountConfig(id, label);
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

  if (command === "login") {
    const [id] = args;
    if (!id) usage();

    const config = await loadCollectorConfig();
    const account = config.accounts.find((item) => item.id === id);
    if (!account) {
      throw new Error(`Unknown account id: ${id}`);
    }

    await openClaudeLogin(account);
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
