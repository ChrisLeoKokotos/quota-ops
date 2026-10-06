import { homedir } from "node:os";
import { join, resolve } from "node:path";

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

export function getProfileRoot(): string {
  return join(getQuotaOpsHome(), "browser-profiles");
}

export function getDefaultProfileDir(id: string): string {
  return join(getProfileRoot(), id);
}

export function getCollectorTokenPath(): string {
  return join(getQuotaOpsHome(), "collector.token");
}
