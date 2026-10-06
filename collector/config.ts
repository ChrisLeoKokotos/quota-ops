import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type {
  CollectorAccountConfig,
  CollectorConfig,
} from "./types.ts";

const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function getQuotaOpsHome(): string {
  const override = process.env.QUOTAOPS_HOME?.trim();
  return override ? resolve(override) : join(homedir(), ".quotaops");
}

export function getCollectorConfigPath(): string {
  const override = process.env.QUOTAOPS_COLLECTOR_CONFIG?.trim();
  return override
    ? resolve(override)
    : join(getQuotaOpsHome(), "collector.json");
}

export function getDefaultProfileDir(id: string): string {
  return join(getQuotaOpsHome(), "browser-profiles", id);
}

export function createDefaultCollectorConfig(): CollectorConfig {
  return {
    version: 1,
    port: 4317,
    pollIntervalSeconds: 300,
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
    typeof candidate.port === "number" &&
    Number.isInteger(candidate.port) &&
    candidate.port >= 1024 &&
    candidate.port <= 65535 &&
    typeof candidate.pollIntervalSeconds === "number" &&
    Number.isFinite(candidate.pollIntervalSeconds) &&
    candidate.pollIntervalSeconds >= 30 &&
    Array.isArray(candidate.accounts) &&
    candidate.accounts.every(isAccountConfig)
  );
}

export async function saveCollectorConfig(
  config: CollectorConfig,
): Promise<void> {
  const path = getCollectorConfigPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function loadCollectorConfig(): Promise<CollectorConfig> {
  const path = getCollectorConfigPath();

  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isCollectorConfig(parsed)) {
      throw new Error(`Invalid QuotaOps collector config: ${path}`);
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
    await mkdir(account.profileDir, { recursive: true });
    config = {
      ...config,
      accounts: [...config.accounts, account],
    };
  }

  await saveCollectorConfig(config);
  return config;
}
