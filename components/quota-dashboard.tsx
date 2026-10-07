"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  clampPercent,
  formatCountdown,
  getAccountStatus,
  getRecommendedAccount,
  getWindowState,
  providerLabel,
  type AccountStatus,
  type QuotaAccount,
  type QuotaWindow,
} from "@/lib/quota";

import {
  getDueResetEvents,
  resetWindowLabel,
} from "@/lib/reset-notifications";
import {
  fetchCollectorSnapshot,
  type CollectorConnectionState,
} from "@/lib/collector-client";
import {
  parseVoiceUsageCommand,
  voiceWindowLabel,
} from "@/lib/voice-command";

const STORAGE_KEY = "quotaops:accounts:v2";
const THEME_KEY = "quotaops:theme";
const NOTIFICATIONS_KEY = "quotaops:notifications";
const SEEN_RESETS_KEY = "quotaops:seen-resets";
const SIDEBAR_KEY = "quotaops:sidebar-open";

type Theme = "light" | "dark";
type Toast = { id: string; message: string };

interface SpeechRecognitionEventLike {
  results: ArrayLike<{ 0: { transcript: string } }>;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
  message?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const STATUS_COPY: Record<AccountStatus, string> = {
  available: "Available",
  low: "Low capacity",
  limited: "At limit",
  exhausted: "Max usage",
  needs_setup: "Needs setup",
  refresh_required: "Refresh required",
};

function SvgIcon({
  children,
  size = 18,
}: {
  children: React.ReactNode;
  size?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      {children}
    </svg>
  );
}

function OverviewIcon() {
  return (
    <SvgIcon>
      <path d="M4 11.5 12 5l8 6.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
      <path d="M6.5 10v8.5h11V10" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
    </SvgIcon>
  );
}

function AccountsIcon() {
  return (
    <SvgIcon>
      <rect x="4.5" y="5" width="15" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8.5 9h7M8.5 13h7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </SvgIcon>
  );
}

function PlusIcon() {
  return (
    <SvgIcon size={16}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </SvgIcon>
  );
}

function SidebarIcon() {
  return (
    <SvgIcon size={18}>
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8.5 4v16" stroke="currentColor" strokeWidth="1.6" />
    </SvgIcon>
  );
}


function SunIcon() {
  return (
    <SvgIcon size={17}>
      <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.7" />
      <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
    </SvgIcon>
  );
}

function MoonIcon() {
  return (
    <SvgIcon size={17}>
      <path d="M19.2 15.2A7.5 7.5 0 0 1 8.8 4.8 7.7 7.7 0 1 0 19.2 15.2Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" />
    </SvgIcon>
  );
}

function BellIcon() {
  return (
    <SvgIcon size={17}>
      <path d="M6.5 9.5a5.5 5.5 0 0 1 11 0v3.2l1.5 2.4H5l1.5-2.4V9.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
      <path d="M10 18h4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </SvgIcon>
  );
}

function MicIcon() {
  return (
    <SvgIcon size={17}>
      <rect x="9" y="3.5" width="6" height="10" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M6.5 11.5a5.5 5.5 0 0 0 11 0M12 17v3M9.5 20h5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </SvgIcon>
  );
}

function KeyboardIcon() {
  return (
    <SvgIcon size={17}>
      <rect x="3.5" y="6.5" width="17" height="11" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 13.5h8" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
    </SvgIcon>
  );
}

function TrashIcon() {
  return (
    <SvgIcon size={15}>
      <path d="M5 7h14M9 7V4.8h6V7M8 10v7M12 10v7M16 10v7M6.5 7l.7 13h9.6l.7-13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" />
    </SvgIcon>
  );
}

function isQuotaWindow(value: unknown): value is QuotaWindow {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QuotaWindow>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.usedPercent === "number" &&
    (typeof candidate.resetAt === "string" || candidate.resetAt === null)
  );
}

function normalizeStoredAccount(value: unknown): QuotaAccount | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.label !== "string" ||
    (candidate.email !== undefined && typeof candidate.email !== "string") ||
    (candidate.provider !== "claude" && candidate.provider !== "openai") ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  const source =
    candidate.source === "manual" || candidate.source === "collector"
      ? candidate.source
      : undefined;

  let windows: QuotaWindow[] | null = null;
  if (
    Array.isArray(candidate.windows) &&
    candidate.windows.length > 0 &&
    candidate.windows.every(isQuotaWindow)
  ) {
    windows = candidate.windows.map((window) => ({
      ...window,
      usedPercent: clampPercent(window.usedPercent),
    }));
  } else if (
    candidate.provider === "claude" &&
    candidate.fiveHour &&
    candidate.weekly &&
    typeof candidate.fiveHour === "object" &&
    typeof candidate.weekly === "object"
  ) {
    const fiveHour = candidate.fiveHour as {
      usedPercent?: unknown;
      resetAt?: unknown;
    };
    const weekly = candidate.weekly as {
      usedPercent?: unknown;
      resetAt?: unknown;
    };

    if (
      typeof fiveHour.usedPercent === "number" &&
      (typeof fiveHour.resetAt === "string" || fiveHour.resetAt === null) &&
      typeof weekly.usedPercent === "number" &&
      (typeof weekly.resetAt === "string" || weekly.resetAt === null)
    ) {
      windows = [
        {
          id: "five-hour",
          label: "5-hour",
          usedPercent: clampPercent(fiveHour.usedPercent),
          resetAt: fiveHour.resetAt,
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPercent: clampPercent(weekly.usedPercent),
          resetAt: weekly.resetAt,
        },
      ];
    }
  }

  if (!windows) return null;

  return {
    id: candidate.id,
    label: candidate.label,
    ...(typeof candidate.email === "string" ? { email: candidate.email } : {}),
    provider: candidate.provider,
    plan:
      typeof candidate.plan === "string" && candidate.plan.trim()
        ? candidate.plan
        : candidate.provider === "claude"
          ? "Team"
          : "ChatGPT",
    windows,
    updatedAt: candidate.updatedAt,
    ...(source ? { source } : {}),
  };
}

function loadAccounts(): QuotaAccount[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map(normalizeStoredAccount)
      .filter((account): account is QuotaAccount => account !== null);
  } catch {
    return [];
  }
}

function loadBoolean(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function loadSidebarOpen(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_KEY) !== "false";
  } catch {
    return true;
  }
}


function loadSeenResets(): Set<string> {
  try {
    const raw = window.localStorage.getItem(SEEN_RESETS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? new Set(parsed)
      : new Set();
  } catch {
    return new Set();
  }
}

function loadTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Fall through to system preference.
  }

  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function toDateTimeLocal(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function localInputToIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatResetTimestamp(iso: string | null): string {
  if (!iso) return "Set reset time";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Set reset time";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function hasResetReached(resetAt: string | null, nowMs: number): boolean {
  if (!resetAt) return false;
  const resetMs = Date.parse(resetAt);
  return Number.isFinite(resetMs) && resetMs <= nowMs;
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function UsageBar({
  value,
  state,
}: {
  value: number;
  state: ReturnType<typeof getWindowState>;
}) {
  const normalized = clampPercent(value);
  return (
    <div
      className="usage-track"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={normalized}
      aria-label={`${normalized}% used`}
      data-state={state}
    >
      <span className="usage-fill" style={{ width: `${normalized}%` }} />
    </div>
  );
}

function QuotaRow({
  title,
  quotaWindow,
  nowMs,
  onChange,
  editable = true,
}: {
  title: string;
  quotaWindow: QuotaWindow;
  nowMs: number;
  onChange: (next: QuotaWindow) => void;
  editable?: boolean;
}) {
  const state = getWindowState(quotaWindow, nowMs);
  const value = clampPercent(quotaWindow.usedPercent);

  return (
    <section className="quota-row">
      <div className="quota-row-main">
        <div className="quota-copy">
          <span className="quota-title">{title}</span>
          <strong>{value}%</strong>
        </div>
        <UsageBar value={value} state={state} />
      </div>

      <div className="reset-copy">
        <strong>{formatCountdown(quotaWindow.resetAt, nowMs)}</strong>
        <span>
          {hasResetReached(quotaWindow.resetAt, nowMs)
            ? "Update current usage"
            : formatResetTimestamp(quotaWindow.resetAt)}
        </span>
      </div>

      {editable ? (
      <details className="inline-editor">
        <summary>Edit</summary>
        <div className="edit-grid">
          <label>
            Usage %
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={quotaWindow.usedPercent}
              onChange={(event) =>
                onChange({
                  ...quotaWindow,
                  usedPercent: clampPercent(Number(event.target.value)),
                })
              }
            />
          </label>
          <label>
            Reset time
            <input
              type="datetime-local"
              value={toDateTimeLocal(quotaWindow.resetAt)}
              onChange={(event) =>
                onChange({
                  ...quotaWindow,
                  resetAt: localInputToIso(event.target.value),
                })
              }
            />
          </label>
        </div>
      </details>
      ) : (
        <span className="auto-sync-label">Auto</span>
      )}
    </section>
  );
}

function AccountCard({
  account,
  nowMs,
  recommended,
  onChange,
  onDelete,
}: {
  account: QuotaAccount;
  nowMs: number;
  recommended: boolean;
  onChange: (next: QuotaAccount) => void;
  onDelete: () => void;
}) {
  const status = getAccountStatus(account, nowMs);

  const updateWindow = (windowId: string, nextWindow: QuotaWindow) => {
    onChange({
      ...account,
      windows: account.windows.map((window) =>
        window.id === windowId ? nextWindow : window,
      ),
      updatedAt: new Date().toISOString(),
    });
  };

  return (
    <article className="account-card" data-status={status}>
      <header className="account-header">
        <div>
          <div className="account-name-row">
            <h2>{account.label}</h2>
            {recommended ? <span className="recommended">Best capacity</span> : null}
          </div>
          <p>
            {providerLabel(account.provider)} {account.plan} · {account.source === "collector" ? "auto-synced" : "manual"} · updated {formatUpdatedAt(account.updatedAt)}
          </p>
          {account.email ? <p>{account.email}</p> : null}
        </div>

        <span className="status-badge" data-status={status}>
          <span className="status-dot" aria-hidden="true" />
          {STATUS_COPY[status]}
        </span>
      </header>

      <div className="quota-list">
        {account.windows.map((window) => (
          <QuotaRow
            key={window.id}
            title={window.label}
            quotaWindow={window}
            nowMs={nowMs}
            onChange={(next) => updateWindow(window.id, next)}
            editable={account.source !== "collector"}
          />
        ))}
      </div>

      <details className="account-editor">
        <summary>Account details</summary>
        <div className="account-settings-grid">
          <label>
            Display name
            <input
              value={account.label}
              maxLength={40}
              onChange={(event) =>
                onChange({
                  ...account,
                  label: event.target.value,
                  updatedAt: new Date().toISOString(),
                })
              }
            />
          </label>
          <label>
            Email
            <input
              type="email"
              value={account.email ?? ""}
              maxLength={254}
              placeholder="dev@example.com"
              onChange={(event) => {
                const email = event.target.value.trim();
                const { email: _currentEmail, ...accountWithoutEmail } = account;
                onChange(
                  email
                    ? {
                        ...account,
                        email,
                        updatedAt: new Date().toISOString(),
                      }
                    : {
                        ...accountWithoutEmail,
                        updatedAt: new Date().toISOString(),
                      },
                );
              }}
            />
          </label>
          {account.source !== "collector" ? (
            <button className="danger-button" type="button" onClick={onDelete}>
              <TrashIcon />
              Remove account
            </button>
          ) : (
            <span className="auto-sync-label">Local profile details</span>
          )}
        </div>
      </details>
    </article>
  );
}

function AddAccountDialog({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (account: QuotaAccount) => void;
}) {
  const [label, setLabel] = useState("");
  const [provider, setProvider] = useState<"claude" | "openai">("claude");
  const [fiveHourUsed, setFiveHourUsed] = useState("0");
  const [fiveHourReset, setFiveHourReset] = useState("");
  const [weeklyUsed, setWeeklyUsed] = useState("0");
  const [weeklyReset, setWeeklyReset] = useState("");

  useEffect(() => {
    if (!open) return;
    setLabel("");
    setProvider("claude");
    setFiveHourUsed("0");
    setFiveHourReset("");
    setWeeklyUsed("0");
    setWeeklyReset("");
  }, [open]);

  if (!open) return null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedLabel = label.trim();
    if (!trimmedLabel) return;

    const now = new Date().toISOString();
    onAdd({
      id: globalThis.crypto?.randomUUID?.() ?? `account-${Date.now()}`,
      label: trimmedLabel,
      provider,
      plan: provider === "claude" ? "Team" : "ChatGPT",
      windows: [
        {
          id: "five-hour",
          label: "5-hour",
          usedPercent: clampPercent(Number(fiveHourUsed)),
          resetAt: localInputToIso(fiveHourReset),
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPercent: clampPercent(Number(weeklyUsed)),
          resetAt: localInputToIso(weeklyReset),
        },
      ],
      updatedAt: now,
    });
    onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        aria-labelledby="add-account-title"
        aria-modal="true"
        className="modal-card"
        role="dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="page-kicker">AI account</span>
            <h2 id="add-account-title">Add account</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form onSubmit={submit}>
          <label>
            Provider
            <select
              value={provider}
              onChange={(event) =>
                setProvider(event.target.value === "openai" ? "openai" : "claude")
              }
            >
              <option value="claude">Claude</option>
              <option value="openai">OpenAI / Codex</option>
            </select>
          </label>

          <label>
            Account label
            <input
              autoFocus
              maxLength={40}
              placeholder={provider === "claude" ? "Dev 1" : "OpenAI 1"}
              required
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          </label>

          <div className="form-section">
            <span>5-hour window</span>
            <div className="form-grid">
              <label>
                Usage %
                <input
                  min={0}
                  max={100}
                  step={0.1}
                  type="number"
                  value={fiveHourUsed}
                  onChange={(event) => setFiveHourUsed(event.target.value)}
                />
              </label>
              <label>
                Reset time
                <input
                  type="datetime-local"
                  value={fiveHourReset}
                  onChange={(event) => setFiveHourReset(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="form-section">
            <span>Weekly window</span>
            <div className="form-grid">
              <label>
                Usage %
                <input
                  min={0}
                  max={100}
                  step={0.1}
                  type="number"
                  value={weeklyUsed}
                  onChange={(event) => setWeeklyUsed(event.target.value)}
                />
              </label>
              <label>
                Reset time
                <input
                  type="datetime-local"
                  value={weeklyReset}
                  onChange={(event) => setWeeklyReset(event.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="modal-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" type="submit">
              Add account
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function QuotaDashboard() {
  const [accounts, setAccounts] = useState<QuotaAccount[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const [ready, setReady] = useState(false);
  const [theme, setTheme] = useState<Theme>("light");
  const [addOpen, setAddOpen] = useState(false);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [listening, setListening] = useState(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [collectorState, setCollectorState] = useState<CollectorConnectionState>("checking");
  const [collectorIssues, setCollectorIssues] = useState<string[]>([]);
  const [collectorLastSync, setCollectorLastSync] = useState<string | null>(null);
  const seenResetsRef = useRef<Set<string>>(new Set());
  const speechRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    setAccounts(loadAccounts());
    const initialTheme = loadTheme();
    setTheme(initialTheme);
    document.documentElement.dataset.theme = initialTheme;
    setNowMs(Date.now());
    setNotificationsEnabled(loadBoolean(NOTIFICATIONS_KEY));
    setSidebarOpen(loadSidebarOpen());
    seenResetsRef.current = loadSeenResets();
    setReady(true);

    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
    } catch {
      // The dashboard remains usable in memory if browser storage is unavailable.
    }
  }, [accounts, ready]);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(SIDEBAR_KEY, String(sidebarOpen));
    } catch {
      // Sidebar state still applies for the current session.
    }
  }, [ready, sidebarOpen]);


  useEffect(() => {
    if (!ready) return;

    let cancelled = false;
    let controller: AbortController | null = null;

    const sync = async () => {
      controller?.abort();
      controller = new AbortController();

      try {
        const snapshot = await fetchCollectorSnapshot(controller.signal);
        if (cancelled) return;

        setCollectorState("connected");
        setCollectorLastSync(snapshot.generatedAt);
        setCollectorIssues(
          snapshot.issues.map((issue) =>
            issue.message ? `${issue.label}: ${issue.message}` : `${issue.label}: ${issue.status}`,
          ),
        );

        if (snapshot.accounts.length > 0) {
          setAccounts((current) => {
            const collectorLabels = new Set(
              snapshot.accounts.map(
                (account) =>
                  `${account.provider}:${account.label.trim().toLowerCase()}`,
              ),
            );
            const collectorIds = new Set(snapshot.accounts.map((account) => account.id));

            const preserved = current.filter((account) => {
              if (collectorIds.has(account.id)) return false;
              if (
                account.source !== "collector" &&
                collectorLabels.has(
                  `${account.provider}:${account.label.trim().toLowerCase()}`,
                )
              ) {
                return false;
              }
              return true;
            });

            const mergedCollectorAccounts = snapshot.accounts.map((account) => {
              const existing = current.find((item) => item.id === account.id);
              return {
                ...account,
                label: existing?.label?.trim() || account.label,
                ...(existing?.email?.trim()
                  ? { email: existing.email.trim() }
                  : {}),
              };
            });

            return [...preserved, ...mergedCollectorAccounts];
          });
        }
      } catch {
        if (cancelled) return;
        setCollectorState("offline");
      }
    };

    void sync();
    const timer = window.setInterval(() => void sync(), 30_000);

    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Theme still applies for the current session.
    }
  }, [theme, ready]);

  useEffect(() => {
    if (!ready || !notificationsEnabled || !nowMs) return;

    const due = getDueResetEvents(accounts, nowMs, seenResetsRef.current);
    if (due.length === 0) return;

    for (const event of due) {
      seenResetsRef.current.add(event.key);
      const message = `${event.accountLabel}: ${resetWindowLabel(event.windowLabel)} reset is due.`;
      setToasts((current) => [...current, { id: event.key, message }]);

      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("QuotaOps", { body: message });
      }
    }

    try {
      window.localStorage.setItem(
        SEEN_RESETS_KEY,
        JSON.stringify([...seenResetsRef.current]),
      );
    } catch {
      // In-app notifications still work.
    }
  }, [accounts, notificationsEnabled, nowMs, ready]);

  useEffect(() => {
    if (!ready) return;

    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (typing) return;

      if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        setAddOpen(true);
      } else if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        setTheme((current) => (current === "light" ? "dark" : "light"));
      } else if (event.key === "?") {
        event.preventDefault();
        setShortcutHelpOpen(true);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [ready]);

  const recommended = useMemo(
    () => (nowMs ? getRecommendedAccount(accounts, nowMs) : null),
    [accounts, nowMs],
  );

  const summary = useMemo(() => {
    if (!nowMs) {
      return { available: 0, low: 0, limited: 0, refresh: 0, setup: 0 };
    }

    return accounts.reduce(
      (acc, account) => {
        const status = getAccountStatus(account, nowMs);
        if (status === "available") acc.available += 1;
        if (status === "low") acc.low += 1;
        if (status === "limited" || status === "exhausted") acc.limited += 1;
        if (status === "refresh_required") acc.refresh += 1;
        if (status === "needs_setup") acc.setup += 1;
        return acc;
      },
      { available: 0, low: 0, limited: 0, refresh: 0, setup: 0 },
    );
  }, [accounts, nowMs]);

  const updateAccount = (next: QuotaAccount) => {
    setAccounts((current) =>
      current.map((account) => (account.id === next.id ? next : account)),
    );
  };

  const enableNotifications = async () => {
    if (!("Notification" in window)) {
      setToasts((current) => [
        ...current,
        { id: String(Date.now()), message: "Notifications are not supported by this browser." },
      ]);
      return;
    }

    const permission = await Notification.requestPermission();
    const enabled = permission === "granted";
    setNotificationsEnabled(enabled);
    try {
      window.localStorage.setItem(NOTIFICATIONS_KEY, String(enabled));
    } catch {
      // Preference still applies for the current session.
    }
  };

  const toggleNotifications = () => {
    if (!notificationsEnabled) {
      void enableNotifications();
      return;
    }
    setNotificationsEnabled(false);
    try {
      window.localStorage.setItem(NOTIFICATIONS_KEY, "false");
    } catch {
      // Preference still applies for the current session.
    }
  };

  const showToast = (message: string) => {
    setToasts((current) => [
      ...current,
      { id: `${Date.now()}-${Math.random()}`, message },
    ]);
  };

  const ensureMicrophonePermission = async (): Promise<boolean> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      return true;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      return true;
    } catch (error) {
      const name =
        error instanceof DOMException ? error.name : "MicrophoneError";

      if (name === "NotAllowedError" || name === "SecurityError") {
        showToast(
          "Microphone access is blocked. Allow microphone permission for localhost in your browser, then try again.",
        );
      } else if (name === "NotFoundError") {
        showToast("No microphone was detected on this device.");
      } else {
        showToast("Could not access the microphone. Check your browser and Windows microphone settings.");
      }

      return false;
    }
  };

  const startVoiceCommand = async () => {
    const speechWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const Recognition =
      speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;

    if (!Recognition) {
      showToast(
        "Voice input is not supported by this browser. Try the latest Chrome or Edge.",
      );
      return;
    }

    if (!(await ensureMicrophonePermission())) {
      setListening(false);
      return;
    }

    speechRef.current?.stop();
    const recognition = new Recognition();
    speechRef.current = recognition;

    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;

    recognition.onstart = () => {
      setListening(true);
      showToast('Listening… Try: "Dev 1 weekly 82".');
    };

    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim() ?? "";
      if (!transcript) {
        showToast("I did not catch any speech. Try again and speak close to the microphone.");
        return;
      }

      const command = parseVoiceUsageCommand(transcript, accounts);

      if (!command) {
        showToast(
          `Heard: "${transcript}". Try: "Dev 1 weekly 82" or "Dev 2 five hour 40".`,
        );
        return;
      }

      setAccounts((current) =>
        current.map((account) => {
          if (account.id !== command.accountId) return account;
          return {
            ...account,
            windows: account.windows.map((window) =>
              window.id === command.windowId
                ? { ...window, usedPercent: command.usedPercent }
                : window,
            ),
            updatedAt: new Date().toISOString(),
          };
        }),
      );

      showToast(
        `Updated ${command.accountLabel} ${voiceWindowLabel(command.windowLabel)} to ${command.usedPercent}%.`,
      );
    };

    recognition.onerror = (event) => {
      setListening(false);

      const copy: Record<string, string> = {
        "not-allowed":
          "Microphone permission was denied. Allow microphone access for localhost and try again.",
        "service-not-allowed":
          "The browser speech-recognition service is blocked or unavailable.",
        "audio-capture":
          "The browser could not capture microphone audio. Check Windows microphone permissions.",
        "no-speech":
          "No speech was detected. Try again and speak after Listening appears.",
        network:
          "Speech recognition could not reach the browser speech service. Voice input may require internet access.",
        aborted: "Voice input was stopped.",
      };

      showToast(
        copy[event.error] ??
          `Voice input failed (${event.error}). Try Chrome/Edge and check microphone permissions.`,
      );
    };

    recognition.onend = () => {
      setListening(false);
    };

    try {
      recognition.start();
    } catch {
      setListening(false);
      showToast("Voice input could not start. Wait a moment and try again.");
    }
  };

  const removeAccount = (account: QuotaAccount) => {
    if (!window.confirm(`Remove ${account.label} from QuotaOps?`)) return;
    setAccounts((current) => current.filter((item) => item.id !== account.id));
  };

  if (!ready || !nowMs) {
    return (
      <main className="loading-shell">
        <div className="loading-card">Loading QuotaOps…</div>
      </main>
    );
  }

  return (
    <>
      <div className="app-shell" data-sidebar-open={sidebarOpen ? "true" : "false"}>
        {sidebarOpen ? (
        <aside className="sidebar">
          <div className="sidebar-top">
            <div className="sidebar-brand">
              <strong>QuotaOps</strong>
              <span>by SO HOMELY</span>
            </div>
            <button
              aria-label="Close sidebar"
              className="sidebar-toggle sidebar-toggle-inside"
              title="Close sidebar"
              type="button"
              onClick={() => setSidebarOpen(false)}
            >
              <SidebarIcon />
            </button>
          </div>

          <nav className="sidebar-nav" aria-label="Primary navigation">
            <a className="nav-item active" href="#overview">
              <OverviewIcon />
              Overview
            </a>
            <a className="nav-item" href="#accounts">
              <AccountsIcon />
              Accounts
            </a>
          </nav>

          <div className="sidebar-footer">
            <button
              className="theme-button"
              type="button"
              onClick={() => setTheme((current) => current === "light" ? "dark" : "light")}
            >
              {theme === "light" ? <MoonIcon /> : <SunIcon />}
              <span>{theme === "light" ? "Dark mode" : "Light mode"}</span>
            </button>

            <button
              className="theme-button"
              type="button"
              onClick={toggleNotifications}
            >
              <BellIcon />
              <span>{notificationsEnabled ? "Notifications on" : "Enable notifications"}</span>
            </button>

            <button
              className="theme-button"
              type="button"
              onClick={() => setShortcutHelpOpen(true)}
            >
              <KeyboardIcon />
              <span>Keyboard shortcuts</span>
            </button>

            <div className="collector-status" data-state={collectorState}>
              <span className="collector-dot" aria-hidden="true" />
              <div>
                <strong>
                  {collectorState === "connected"
                    ? "Collector connected"
                    : collectorState === "checking"
                      ? "Checking collector"
                      : "Manual fallback"}
                </strong>
                <span>
                  {collectorState === "connected" && collectorLastSync
                    ? `Local sync ${formatUpdatedAt(collectorLastSync)}`
                    : "127.0.0.1 only"}
                </span>
              </div>
            </div>
          </div>
        </aside>
        ) : (
          <button
            aria-label="Open sidebar"
            className="sidebar-toggle sidebar-toggle-floating"
            title="Open sidebar"
            type="button"
            onClick={() => setSidebarOpen(true)}
          >
            <SidebarIcon />
          </button>
        )}

        <main className="workspace">
          <section id="overview" className="page-header">
            <div>
              <span className="page-kicker">Capacity overview</span>
              <h1>Keep every account ready for the next task.</h1>
              <p>
                Track Claude and OpenAI accounts, quota windows, and exact
                reset times from one local workspace.
              </p>
            </div>

            <div className="header-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => void startVoiceCommand()}
                aria-pressed={listening}
              >
                <MicIcon />
                {listening ? "Listening…" : "Voice input"}
              </button>
              <button className="primary-button add-account-button" type="button" onClick={() => setAddOpen(true)}>
                <PlusIcon />
                Add account
              </button>
            </div>
          </section>

          <section className="metrics" aria-label="Capacity summary">
            <div className="metric">
              <span>Available now</span>
              <strong>{summary.available}<small> / {accounts.length}</small></strong>
            </div>
            <div className="metric">
              <span>Low capacity</span>
              <strong>{summary.low}</strong>
            </div>
            <div className="metric">
              <span>At limit</span>
              <strong>{summary.limited}</strong>
            </div>
            <div className="metric metric-highlight">
              <span>Recommended</span>
              <strong>{recommended?.label ?? "—"}</strong>
            </div>
          </section>

          {collectorIssues.length > 0 ? (
            <div className="notice" role="status">
              <strong>Collector needs attention.</strong>
              <span>{collectorIssues[0]}</span>
            </div>
          ) : null}

          {summary.refresh > 0 || summary.setup > 0 ? (
            <div className="notice" role="status">
              <strong>
                {summary.refresh > 0
                  ? `${summary.refresh} account${summary.refresh === 1 ? "" : "s"} need updated usage.`
                  : `${summary.setup} account${summary.setup === 1 ? "" : "s"} need setup.`}
              </strong>
              <span>
                {summary.refresh > 0
                  ? "A known reset time has passed. Enter the current quota snapshot."
                  : "Add the missing reset times to make recommendations reliable."}
              </span>
            </div>
          ) : null}

          <section className="tips-panel" aria-label="Quota tips">
            <div className="tips-heading">
              <span className="page-kicker">Tips</span>
              <h2>What needs attention</h2>
            </div>
            <div className="tips-list">
              {accounts.length === 0 ? (
                <div className="tip-item">Add your first account to start getting capacity tips.</div>
              ) : (
                <>
                  {accounts
                    .filter((account) => {
                      const status = getAccountStatus(account, nowMs);
                      return status === "limited" || status === "exhausted";
                    })
                    .slice(0, 2)
                    .map((account) => {
                      const blocked = account.windows.find(
                        (window) => clampPercent(window.usedPercent) >= 100,
                      );
                      return (
                        <div className="tip-item" key={`limited-${account.id}`}>
                          <strong>{account.label}</strong>
                          <span>
                            {blocked
                              ? `${blocked.label} quota is maxed. ${formatCountdown(blocked.resetAt, nowMs)} remaining.`
                              : "One or more quota windows are at their limit."}
                          </span>
                        </div>
                      );
                    })}
                  {accounts
                    .filter((account) => getAccountStatus(account, nowMs) === "refresh_required")
                    .slice(0, 2)
                    .map((account) => (
                      <div className="tip-item" key={`refresh-${account.id}`}>
                        <strong>{account.label}</strong>
                        <span>A known reset was reached. Update the current usage before relying on this account.</span>
                      </div>
                    ))}
                  {accounts
                    .filter((account) => getAccountStatus(account, nowMs) === "needs_setup")
                    .slice(0, 2)
                    .map((account) => (
                      <div className="tip-item" key={`setup-${account.id}`}>
                        <strong>{account.label}</strong>
                        <span>Some reset times are missing. Complete setup for accurate status and recommendations.</span>
                      </div>
                    ))}
                  {recommended ? (
                    <div className="tip-item">
                      <strong>{recommended.label}</strong>
                      <span>Currently has the best usable capacity for the next task.</span>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </section>

          <section id="accounts" className="accounts-section">
            <div className="section-heading">
              <div>
                <span className="page-kicker">Accounts</span>
                <h2>AI accounts</h2>
              </div>
              <span>{accounts.length} account{accounts.length === 1 ? "" : "s"}</span>
            </div>

            {accounts.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon"><AccountsIcon /></div>
                <h3>Add your first account</h3>
                <p>
                  Start with one Claude Team account and enter the usage and reset
                  times shown in Claude. Everything stays in this browser.
                </p>
                <button className="primary-button" type="button" onClick={() => setAddOpen(true)}>
                  <PlusIcon />
                  Add account
                </button>
              </div>
            ) : (
              <div className="account-grid">
                {accounts.map((account) => (
                  <AccountCard
                    key={account.id}
                    account={account}
                    nowMs={nowMs}
                    recommended={recommended?.id === account.id}
                    onChange={updateAccount}
                    onDelete={() => removeAccount(account)}
                  />
                ))}
              </div>
            )}
          </section>

          <footer className="privacy-note">
            <strong>Local-first.</strong>
            <span>
              Manual data stays in this browser. Auto-sync uses a collector bound
              only to 127.0.0.1 on this PC; provider browser profiles remain local.
            </span>
          </footer>
        </main>
      </div>

      <AddAccountDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={(account) => setAccounts((current) => [...current, account])}
      />

      {shortcutHelpOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShortcutHelpOpen(false)}>
          <div className="modal-card shortcut-card" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <span className="page-kicker">Productivity</span>
                <h2>Keyboard shortcuts</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setShortcutHelpOpen(false)} aria-label="Close">×</button>
            </div>
            <div className="shortcut-list">
              <div><span>Add account</span><kbd>N</kbd></div>
              <div><span>Toggle theme</span><kbd>T</kbd></div>
              <div><span>Open shortcuts</span><kbd>?</kbd></div>
            </div>
          </div>
        </div>
      ) : null}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <button
            className="toast"
            key={toast.id}
            type="button"
            onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
          >
            {toast.message}
          </button>
        ))}
      </div>
    </>
  );
}
