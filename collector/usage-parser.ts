import { clampPercent, type QuotaWindow } from "../lib/quota.ts";

export interface ParsedUsage {
  fiveHour: QuotaWindow;
  weekly: QuotaWindow;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function parseResetAt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null;
}

function parseWindow(value: unknown): QuotaWindow | null {
  const record = asRecord(value);
  if (!record) return null;

  const rawPercent =
    typeof record.utilization === "number"
      ? record.utilization
      : typeof record.percent === "number"
        ? record.percent
        : null;

  if (rawPercent === null || !Number.isFinite(rawPercent)) return null;

  return {
    usedPercent: clampPercent(rawPercent),
    resetAt: parseResetAt(record.resets_at ?? record.reset_at),
  };
}


function organizationId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;

  const raw =
    typeof record.uuid === "string"
      ? record.uuid
      : typeof record.id === "string"
        ? record.id
        : null;

  return raw && /^[A-Za-z0-9_-]+$/.test(raw) ? raw : null;
}

function hasChatCapability(value: unknown): boolean {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.capabilities)) return false;
  return record.capabilities.some(
    (capability) => capability === "chat",
  );
}

export function resolveClaudeUsageOrganizationId(
  payload: unknown,
  preferredOrganizationId?: string | null,
): string | null {
  if (!Array.isArray(payload)) return null;

  const organizations = payload
    .map((value) => ({
      id: organizationId(value),
      chat: hasChatCapability(value),
    }))
    .filter(
      (organization): organization is { id: string; chat: boolean } =>
        organization.id !== null,
    );

  if (organizations.length === 0) return null;

  const preferredChat = preferredOrganizationId
    ? organizations.find(
        (organization) =>
          organization.id === preferredOrganizationId && organization.chat,
      )
    : null;
  if (preferredChat) return preferredChat.id;

  const chatOrganization = organizations.find((organization) => organization.chat);
  if (chatOrganization) return chatOrganization.id;

  if (preferredOrganizationId) {
    const preferred = organizations.find(
      (organization) => organization.id === preferredOrganizationId,
    );
    if (preferred) return preferred.id;
  }

  return organizations[0]?.id ?? null;
}

function parseNamedLimit(
  root: Record<string, unknown>,
  names: readonly string[],
): QuotaWindow | null {
  for (const name of names) {
    const direct = parseWindow(root[name]);
    if (direct) return direct;
  }

  const limits = root.limits;
  if (!Array.isArray(limits)) return null;

  for (const item of limits) {
    const record = asRecord(item);
    const kind =
      typeof record?.kind === "string"
        ? record.kind
        : typeof record?.name === "string"
          ? record.name
          : null;

    if (!kind || !names.includes(kind)) continue;
    const parsed = parseWindow(record);
    if (parsed) return parsed;
  }

  return null;
}

export function parseClaudeUsagePayload(payload: unknown): ParsedUsage | null {
  const root = asRecord(payload);
  if (!root) return null;

  const fiveHour = parseNamedLimit(root, [
    "five_hour",
    "current_session",
    "session",
  ]);

  const weekly = parseNamedLimit(root, [
    "seven_day",
    "weekly_all",
    "current_week",
    "weekly",
  ]);

  if (!fiveHour || !weekly) return null;

  return { fiveHour, weekly };
}

export function looksLikeClaudeUsageUrl(
  url: string,
  expectedOrganizationId?: string | null,
): boolean {
  try {
    const parsed = new URL(url);
    const match = /^\/api\/organizations\/([A-Za-z0-9_-]+)\/usage\/?$/.exec(
      parsed.pathname,
    );

    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "claude.ai" &&
      parsed.port === "" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      match !== null &&
      (!expectedOrganizationId || match[1] === expectedOrganizationId)
    );
  } catch {
    return false;
  }
}
