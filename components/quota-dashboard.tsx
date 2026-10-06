"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import {
  clampPercent,
  formatCountdown,
  getAccountStatus,
  getRecommendedAccount,
  getWindowState,
  type AccountStatus,
  type QuotaAccount,
  type QuotaWindow,
} from "@/lib/quota";

const STORAGE_KEY = "quotaops:accounts:v2";
const THEME_KEY = "quotaops:theme";

type Theme = "light" | "dark";

const STATUS_COPY: Record<AccountStatus, string> = {
  available: "Available",
  low: "Low capacity",
  five_hour_limited: "5h limited",
  weekly_limited: "Weekly max",
  exhausted: "Exhausted",
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
    typeof candidate.usedPercent === "number" &&
    (typeof candidate.resetAt === "string" || candidate.resetAt === null)
  );
}

function isQuotaAccount(value: unknown): value is QuotaAccount {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QuotaAccount>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    candidate.provider === "claude" &&
    candidate.plan === "team" &&
    isQuotaWindow(candidate.fiveHour) &&
    isQuotaWindow(candidate.weekly) &&
    typeof candidate.updatedAt === "string"
  );
}

function loadAccounts(): QuotaAccount[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isQuotaAccount)) return [];

    return parsed.map((account) => ({
      ...account,
      fiveHour: {
        ...account.fiveHour,
        usedPercent: clampPercent(account.fiveHour.usedPercent),
      },
      weekly: {
        ...account.weekly,
        usedPercent: clampPercent(account.weekly.usedPercent),
      },
    }));
  } catch {
    return [];
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
}: {
  title: string;
  quotaWindow: QuotaWindow;
  nowMs: number;
  onChange: (next: QuotaWindow) => void;
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
        <span>{formatResetTimestamp(quotaWindow.resetAt)}</span>
      </div>

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

  const updateWindow = (
    key: "fiveHour" | "weekly",
    nextWindow: QuotaWindow,
  ) => {
    onChange({
      ...account,
      [key]: nextWindow,
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
          <p>Claude Team · updated {formatUpdatedAt(account.updatedAt)}</p>
        </div>

        <span className="status-badge" data-status={status}>
          <span className="status-dot" aria-hidden="true" />
          {STATUS_COPY[status]}
        </span>
      </header>

      <div className="quota-list">
        <QuotaRow
          title="5-hour"
          quotaWindow={account.fiveHour}
          nowMs={nowMs}
          onChange={(next) => updateWindow("fiveHour", next)}
        />
        <QuotaRow
          title="Weekly"
          quotaWindow={account.weekly}
          nowMs={nowMs}
          onChange={(next) => updateWindow("weekly", next)}
        />
      </div>

      <details className="account-editor">
        <summary>Account settings</summary>
        <div className="account-settings-grid">
          <label>
            Account label
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
          <button className="danger-button" type="button" onClick={onDelete}>
            <TrashIcon />
            Remove account
          </button>
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
  const [fiveHourUsed, setFiveHourUsed] = useState("0");
  const [fiveHourReset, setFiveHourReset] = useState("");
  const [weeklyUsed, setWeeklyUsed] = useState("0");
  const [weeklyReset, setWeeklyReset] = useState("");

  useEffect(() => {
    if (!open) return;
    setLabel("");
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
      provider: "claude",
      plan: "team",
      fiveHour: {
        usedPercent: clampPercent(Number(fiveHourUsed)),
        resetAt: localInputToIso(fiveHourReset),
      },
      weekly: {
        usedPercent: clampPercent(Number(weeklyUsed)),
        resetAt: localInputToIso(weeklyReset),
      },
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
            <span className="page-kicker">Claude Team</span>
            <h2 id="add-account-title">Add account</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <form onSubmit={submit}>
          <label>
            Account label
            <input
              autoFocus
              maxLength={40}
              placeholder="Dev 1"
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

  useEffect(() => {
    setAccounts(loadAccounts());
    const initialTheme = loadTheme();
    setTheme(initialTheme);
    document.documentElement.dataset.theme = initialTheme;
    setNowMs(Date.now());
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
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Theme still applies for the current session.
    }
  }, [theme, ready]);

  const recommended = useMemo(
    () => (nowMs ? getRecommendedAccount(accounts, nowMs) : null),
    [accounts, nowMs],
  );

  const summary = useMemo(() => {
    if (!nowMs) return { available: 0, weeklyMax: 0, fiveHourMax: 0, refresh: 0 };

    return accounts.reduce(
      (acc, account) => {
        const status = getAccountStatus(account, nowMs);
        if (status === "available" || status === "low") acc.available += 1;
        if (status === "weekly_limited" || status === "exhausted") acc.weeklyMax += 1;
        if (status === "five_hour_limited" || status === "exhausted") acc.fiveHourMax += 1;
        if (status === "refresh_required") acc.refresh += 1;
        return acc;
      },
      { available: 0, weeklyMax: 0, fiveHourMax: 0, refresh: 0 },
    );
  }, [accounts, nowMs]);

  const updateAccount = (next: QuotaAccount) => {
    setAccounts((current) =>
      current.map((account) => (account.id === next.id ? next : account)),
    );
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
      <div className="app-shell">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <span className="brand-mark">Q</span>
            <span>QuotaOps</span>
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

            <div className="collector-status">
              <span className="collector-dot" aria-hidden="true" />
              <div>
                <strong>Local mode</strong>
                <span>Saved in this browser</span>
              </div>
            </div>
          </div>
        </aside>

        <main className="workspace">
          <section id="overview" className="page-header">
            <div>
              <span className="page-kicker">Capacity overview</span>
              <h1>Keep every account ready for the next task.</h1>
              <p>
                Track your real Claude Team accounts, quota windows, and exact
                reset times from one local workspace.
              </p>
            </div>

            <button className="primary-button add-account-button" type="button" onClick={() => setAddOpen(true)}>
              <PlusIcon />
              Add account
            </button>
          </section>

          <section className="metrics" aria-label="Capacity summary">
            <div className="metric">
              <span>Available now</span>
              <strong>{summary.available}<small> / {accounts.length}</small></strong>
            </div>
            <div className="metric">
              <span>Weekly max</span>
              <strong>{summary.weeklyMax}</strong>
            </div>
            <div className="metric">
              <span>5h blocked</span>
              <strong>{summary.fiveHourMax}</strong>
            </div>
            <div className="metric metric-highlight">
              <span>Recommended</span>
              <strong>{recommended?.label ?? "—"}</strong>
            </div>
          </section>

          {summary.refresh > 0 ? (
            <div className="notice" role="status">
              <strong>{summary.refresh} account{summary.refresh === 1 ? "" : "s"} need fresh quota data.</strong>
              <span>Set current usage and reset times before relying on capacity.</span>
            </div>
          ) : null}

          <section id="accounts" className="accounts-section">
            <div className="section-heading">
              <div>
                <span className="page-kicker">Accounts</span>
                <h2>Claude Team</h2>
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
              Account labels, quota percentages, reset timestamps, and theme
              preference are stored only in this browser.
            </span>
          </footer>
        </main>
      </div>

      <AddAccountDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={(account) => setAccounts((current) => [...current, account])}
      />
    </>
  );
}
