import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  getCollectorConfigPath,
  getDefaultProfileDir,
} from "./paths.ts";
import {
  assertSafeProfileDirectory,
  ensureCollectorHomeSecurity,
} from "./security.ts";
import type { Provider } from "../lib/quota.ts";
import type {
  CollectorAccountConfig,
  CollectorConfig,
} from "./types.ts";

const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function createDefaultCollectorConfig(): CollectorConfig {
  return {
    version: 1,
    port: 4317,
    pollIntervalSeconds: 300,
    tokenAnalyticsEnabled: false,
    accounts: [],
  };
}

function isAccountConfig(value: unknown): value is CollectorAccountConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CollectorAccountConfig>;

  return (
    typeof candidate.id === "string" &&
    ACCOUNT_ID.test(candidate.id) &&
    typeof candidate.label === "string" &&
    candidate.label.trim().length > 0 &&
    (candidate.provider === "claude" || candidate.provider === "openai") &&
    typeof candidate.profileDir === "string" &&
    candidate.profileDir.trim().length > 0 &&
    typeof candidate.enabled === "boolean"
  );
}

function isCollectorConfig(value: unknown): value is CollectorConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CollectorConfig>;

  return (
    candidate.version === 1 &&
    candidate.port === 4317 &&
    typeof candidate.pollIntervalSeconds === "number" &&
    Number.isFinite(candidate.pollIntervalSeconds) &&
    candidate.pollIntervalSeconds >= 30 &&
    typeof candidate.tokenAnalyticsEnabled === "boolean" &&
    Array.isArray(candidate.accounts) &&
    candidate.accounts.every(isAccountConfig)
  );
}

export async function saveCollectorConfig(
  config: CollectorConfig,
): Promise<void> {
  await ensureCollectorHomeSecurity();

  if (!isCollectorConfig(config)) {
    throw new Error("Refusing to write an invalid collector configuration.");
  }

  for (const account of config.accounts) {
    await assertSafeProfileDirectory(account.profileDir);
  }

  const path = getCollectorConfigPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function loadCollectorConfig(): Promise<CollectorConfig> {
  await ensureCollectorHomeSecurity();
  const path = getCollectorConfigPath();

  try {
    const raw = await readFile(path, "utf8");
    const parsedRaw: unknown = JSON.parse(raw);
    const parsedRecord =
      parsedRaw && typeof parsedRaw === "object"
        ? (parsedRaw as Record<string, unknown>)
        : null;
    const accountsRaw = Array.isArray(parsedRecord?.accounts)
      ? parsedRecord.accounts.map((account) => {
          if (!account || typeof account !== "object") return account;
          const record = account as Record<string, unknown>;
          return record.provider
            ? record
            : { ...record, provider: "claude" };
        })
      : parsedRecord?.accounts;
    const parsed = parsedRecord
      ? {
          ...parsedRecord,
          accounts: accountsRaw,
          // Existing installations migrate safely: history scanning becomes opt-in.
          tokenAnalyticsEnabled: parsedRecord.tokenAnalyticsEnabled ?? false,
        }
      : parsedRaw;

    if (!isCollectorConfig(parsed)) {
      throw new Error(`Invalid QuotaOps collector config: ${path}`);
    }

    for (const account of parsed.accounts) {
      await assertSafeProfileDirectory(account.profileDir);
    }

    return parsed;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") throw error;

    const config = createDefaultCollectorConfig();
    await saveCollectorConfig(config);
    return config;
  }
}

export function createAccountConfig(
  id: string,
  label: string,
  provider: Provider = "claude",
  profileDir = getDefaultProfileDir(id),
): CollectorAccountConfig {
  const normalizedId = id.trim().toLowerCase();
  if (!ACCOUNT_ID.test(normalizedId)) {
    throw new Error(
      "Account id must use lowercase letters, numbers, hyphens, or underscores.",
    );
  }

  const normalizedLabel = label.trim();
  if (!normalizedLabel) {
    throw new Error("Account label cannot be empty.");
  }

  return {
    id: normalizedId,
    label: normalizedLabel,
    provider,
    profileDir: resolve(profileDir),
    enabled: true,
  };
}

export async function bootstrapFiveAccounts(): Promise<CollectorConfig> {
  let config = await loadCollectorConfig();

  for (let index = 1; index <= 5; index += 1) {
    const id = `dev-${index}`;
    if (config.accounts.some((account) => account.id === id)) continue;

    const account = createAccountConfig(id, `Dev ${index}`);
    await assertSafeProfileDirectory(account.profileDir);
    config = {
      ...config,
      accounts: [...config.accounts, account],
    };
  }

  await saveCollectorConfig(config);
  return config;
}
