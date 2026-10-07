import { clampPercent } from "../lib/quota.ts";

export interface ParsedUsageWindow {
  usedPercent: number;
  resetAt: string | null;
}

export interface ParsedUsage {
  fiveHour: ParsedUsageWindow;
  weekly: ParsedUsageWindow;
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

function parseWindow(value: unknown): ParsedUsageWindow | null {
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

function organizationCapabilities(value: unknown): string[] {
  const record = asRecord(value);
  if (!record || !Array.isArray(record.capabilities)) return [];

  return record.capabilities
    .filter((capability): capability is string => typeof capability === "string")
    .map((capability) => capability.toLowerCase());
}

function organizationRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;

  const root = asRecord(payload);
  if (!root) return [];

  if (Array.isArray(root.organizations)) return root.organizations;
  if (Array.isArray(root.data)) return root.data;
  if (root.organization) return [root.organization];

  return [];
}

const CHAT_PLAN_CAPABILITIES = new Set([
  "claude_team",
  "claude_pro",
  "claude_max",
  "pro",
  "max",
  "raven",
]);

export function resolveClaudeUsageOrganizationIds(
  payload: unknown,
  preferredOrganizationId?: string | null,
): string[] {
  const organizations = organizationRows(payload)
    .map((value) => {
      const id = organizationId(value);
      const capabilities = organizationCapabilities(value);
      return {
        id,
        capabilities,
        chat: capabilities.includes("chat"),
        paidChat: capabilities.some((capability) =>
          CHAT_PLAN_CAPABILITIES.has(capability),
        ),
      };
    })
    .filter(
      (
        organization,
      ): organization is {
        id: string;
        capabilities: string[];
        chat: boolean;
        paidChat: boolean;
      } => organization.id !== null,
    );

  if (organizations.length === 0) return [];

  const ordered: string[] = [];
  const add = (id: string | null | undefined) => {
    if (id && !ordered.includes(id)) ordered.push(id);
  };

  if (preferredOrganizationId) {
    const preferred = organizations.find(
      (organization) => organization.id === preferredOrganizationId,
    );
    if (preferred?.chat && preferred.paidChat) add(preferred.id);
  }

  for (const organization of organizations) {
    if (organization.chat && organization.paidChat) add(organization.id);
  }

  if (preferredOrganizationId) {
    const preferred = organizations.find(
      (organization) => organization.id === preferredOrganizationId,
    );
    if (preferred?.chat) add(preferred.id);
  }

  for (const organization of organizations) {
    if (organization.chat) add(organization.id);
  }

  if (preferredOrganizationId) {
    const preferred = organizations.find(
      (organization) => organization.id === preferredOrganizationId,
    );
    add(preferred?.id);
  }

  for (const organization of organizations) {
    if (organization.capabilities.length === 0) add(organization.id);
  }

  for (const organization of [...organizations].reverse()) {
    add(organization.id);
  }

  return ordered;
}

function parseNamedLimit(
  root: Record<string, unknown>,
  names: readonly string[],
): ParsedUsageWindow | null {
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
