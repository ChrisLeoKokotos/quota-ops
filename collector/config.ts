import { mkdir, readFile, writeFile, rename, rm, rmdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
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
  TokenAnalyticsConsent,
} from "./types.ts";

const ACCOUNT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function createDefaultCollectorConfig(): CollectorConfig {
  return {
    version: 1,
    port: 4317,
    // 15 minutes: each check runs a full browser per account; usage windows
    // are hours long, so fresher reads cost resources without adding value.
    pollIntervalSeconds: 900,
    tokenAnalyticsEnabled: false,
    tokenAnalyticsSources: { claudeCode: false, codex: false },
    accounts: [],
  };
}

function isConsent(value: unknown): value is TokenAnalyticsConsent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TokenAnalyticsConsent>;

  return (
    typeof candidate.claudeCode === "boolean" &&
    typeof candidate.codex === "boolean" &&
    (candidate.googleAntigravity === undefined || typeof candidate.googleAntigravity === "boolean")
  );
}

function isAccountConfig(value: unknown): value is CollectorAccountConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CollectorAccountConfig>;

  return (
    typeof candidate.id === "string" &&
    ACCOUNT_ID.test(candidate.id) &&
    typeof candidate.label === "string" &&
    candidate.label.trim().length > 0 &&
    (candidate.provider === "claude" || candidate.provider === "openai" || candidate.provider === "google") &&
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
    isConsent(candidate.tokenAnalyticsSources) &&
    // The master switch may never imply consent the user has not given.
    (!candidate.tokenAnalyticsEnabled ||
      candidate.tokenAnalyticsSources.claudeCode ||
      candidate.tokenAnalyticsSources.codex ||
      candidate.tokenAnalyticsSources.googleAntigravity === true) &&
    (candidate.tokenConsentRevision === undefined ||
      (typeof candidate.tokenConsentRevision === "string" && /^[a-f0-9-]{36}$/.test(candidate.tokenConsentRevision))) &&
    (candidate.googleTokenConsentEpoch === undefined ||
      (typeof candidate.googleTokenConsentEpoch === "string" && /^[a-f0-9-]{36}$/.test(candidate.googleTokenConsentEpoch))) &&
    Array.isArray(candidate.accounts) &&
    candidate.accounts.every(isAccountConfig) &&
    (candidate.backgroundCollection === undefined ||
      candidate.backgroundCollection === "hidden" ||
      candidate.backgroundCollection === "headless" ||
      candidate.backgroundCollection === "off")
  );
}

/**
 * Converts a pre-consent configuration. A user who had already enabled
 * scanning keeps it for both sources rather than silently losing data; a user
 * who had not stays opted out of both.
 */
export function migrateConsent(record: Record<string, unknown>): TokenAnalyticsConsent {
  const existing = record.tokenAnalyticsSources;
  if (isConsent(existing)) return existing;

  const legacy = record.tokenAnalyticsEnabled === true;
  return { claudeCode: legacy, codex: legacy };
}

async function writeCollectorConfigLocked(
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
  const temporary = path + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2) + "\n", {
      encoding: "utf8", mode: 0o600, flag: "wx",
    });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }).catch(() => undefined); }
}

async function readCollectorConfigLocked(): Promise<CollectorConfig> {
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
          tokenAnalyticsSources: migrateConsent(parsedRecord),
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
    await writeCollectorConfigLocked(config);
    return config;
  }
}

/** All supported writers and sensitive publication paths use this same lock.
 * A crashed owner leaves a lock directory: never guess that it is stale.
 * Stop every QuotaOps/CLI/hook process before manually removing it.
 * Callbacks must not call load/update/withCollectorConfig recursively.
 */
export async function withCollectorConfig<T>(
  action: (current: CollectorConfig) => Promise<T> | T,
): Promise<T> {
  await ensureCollectorHomeSecurity();
  const lock = getCollectorConfigPath() + ".lock";
  const deadline = performance.now() + 1500;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (performance.now() >= deadline) throw new Error("Collector configuration lock busy; retry after the active operation finishes.");
      await delay(25);
    }
  }
  try {
    return await action(await readCollectorConfigLocked());
  } finally {
    await rmdir(lock);
  }
}

export function loadCollectorConfig(): Promise<CollectorConfig> {
  return withCollectorConfig(current => current);
}

/** Mutate the latest configuration inside the lock, never a stale copy. */
export function updateCollectorConfig(
  mutate: (current: CollectorConfig) => CollectorConfig | Promise<CollectorConfig>,
): Promise<CollectorConfig> {
  return withCollectorConfig(async current => {
    const next = await mutate(current);
    await writeCollectorConfigLocked(next);
    return next;
  });
}

export function tokenConsentKey(c: CollectorConfig): string {
  return JSON.stringify([
    c.tokenAnalyticsEnabled, c.tokenAnalyticsSources.claudeCode, c.tokenAnalyticsSources.codex,
    c.tokenAnalyticsSources.googleAntigravity === true, c.googleTokenConsentEpoch ?? null,
    c.tokenConsentRevision ?? null,
  ]);
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
  return updateCollectorConfig(config => {
    const accounts = [...config.accounts];
    for (let index = 1; index <= 5; index += 1) {
      const id = `dev-${index}`;
      if (!accounts.some(account => account.id === id)) accounts.push(createAccountConfig(id, `Dev ${index}`));
    }
    return { ...config, accounts };
  });
}
