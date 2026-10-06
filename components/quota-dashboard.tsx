"use client";

import { useEffect, useMemo, useState } from "react";

import {
  clampPercent,
  createDemoAccounts,
  formatCountdown,
  getAccountStatus,
  getRecommendedAccount,
  getWindowState,
  type AccountStatus,
  type QuotaAccount,
  type QuotaWindow,
} from "@/lib/quota";

const STORAGE_KEY = "quotaops:mvp:v1";

const STATUS_COPY: Record<AccountStatus, string> = {
  available: "Available",
  low: "Low capacity",
  five_hour_limited: "5h limited",
  weekly_limited: "Weekly max",
  exhausted: "Exhausted",
  refresh_required: "Refresh required",
};

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
    if (!raw) return createDemoAccounts();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isQuotaAccount)) {
      return createDemoAccounts();
    }
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
    return createDemoAccounts();
  }
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
  if (!iso) return "Unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown";
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
}: {
  account: QuotaAccount;
  nowMs: number;
  recommended: boolean;
  onChange: (next: QuotaAccount) => void;
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
      </details>
    </article>
  );
}

export function QuotaDashboard() {
  const [accounts, setAccounts] = useState<QuotaAccount[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setAccounts(loadAccounts());
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

  const restoreDemo = () => {
    setAccounts(createDemoAccounts());
    setNowMs(Date.now());
  };

  if (!ready || !nowMs) {
    return (
      <main className="loading-shell">
        <div className="loading-card">Loading local quota snapshots…</div>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">Q</span>
          <span>QuotaOps</span>
        </div>

        <nav className="sidebar-nav" aria-label="Primary navigation">
          <a className="nav-item active" href="#overview">
            <span className="nav-icon" aria-hidden="true">⌂</span>
            Overview
          </a>
          <a className="nav-item" href="#accounts">
            <span className="nav-icon" aria-hidden="true">◫</span>
            Accounts
          </a>
        </nav>

        <div className="sidebar-footer">
          <div className="collector-status">
            <span className="collector-dot" aria-hidden="true" />
            <div>
              <strong>Local mode</strong>
              <span>Manual snapshots</span>
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
              Current Claude Team capacity, reset windows, and the account with
              the most room right now.
            </p>
          </div>

          <button className="ghost-button" type="button" onClick={restoreDemo}>
            Restore demo
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
            <strong>{recommended?.label ?? "None"}</strong>
          </div>
        </section>

        {summary.refresh > 0 ? (
          <div className="notice" role="status">
            <strong>{summary.refresh} snapshot{summary.refresh === 1 ? "" : "s"} need refresh.</strong>
            <span>QuotaOps will not assume new capacity from an expired reset time.</span>
          </div>
        ) : null}

        <section id="accounts" className="accounts-section">
          <div className="section-heading">
            <div>
              <span className="page-kicker">Accounts</span>
              <h2>Claude Team</h2>
            </div>
            <span>{accounts.length} accounts</span>
          </div>

          <div className="account-grid">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                nowMs={nowMs}
                recommended={recommended?.id === account.id}
                onChange={updateAccount}
              />
            ))}
          </div>
        </section>

        <footer className="privacy-note">
          <strong>Local-first.</strong>
          <span>
            QuotaOps stores only labels, percentages, reset timestamps, and update
            times in this browser. No provider credentials or conversation data.
          </span>
        </footer>
      </main>
    </div>
  );
}
