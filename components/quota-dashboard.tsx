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

function isQuotaWindow(value: unknown): value is QuotaWindow {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QuotaWindow>;

  return (
    typeof candidate.usedPercent === "number" &&
    (typeof candidate.resetAt === "string" || candidate.resetAt === null)
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

function QuotaBlock({
  title,
  window,
  nowMs,
  onChange,
}: {
  title: string;
  window: QuotaWindow;
  nowMs: number;
  onChange: (next: QuotaWindow) => void;
}) {
  const state = getWindowState(window, nowMs);

  return (
    <section className="quota-block">
      <div className="quota-heading">
        <div>
          <span className="quota-title">{title}</span>
          <strong>{clampPercent(window.usedPercent)}% used</strong>
        </div>
        <span className="window-state" data-state={state}>
          {state === "exhausted"
            ? "MAX"
            : state === "refresh_required"
              ? "RESET DUE"
              : state === "unknown"
                ? "UNKNOWN"
                : state === "low"
                  ? "LOW"
                  : "OK"}
        </span>
      </div>

      <UsageBar value={window.usedPercent} state={state} />

      <div className="reset-row">
        <span>{formatCountdown(window.resetAt, nowMs)}</span>
        <span>{formatResetTimestamp(window.resetAt)}</span>
      </div>

      <div className="edit-grid">
        <label>
          Usage %
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={window.usedPercent}
            onChange={(event) =>
              onChange({
                ...window,
                usedPercent: clampPercent(Number(event.target.value)),
              })
            }
          />
        </label>
        <label>
          Reset time
          <input
            type="datetime-local"
            value={toDateTimeLocal(window.resetAt)}
            onChange={(event) =>
              onChange({
                ...window,
                resetAt: localInputToIso(event.target.value),
              })
            }
          />
        </label>
      </div>
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
            {recommended ? <span className="recommended">Recommended</span> : null}
          </div>
          <p>Claude Team</p>
        </div>
        <span className="status-badge" data-status={status}>
          {STATUS_COPY[status]}
        </span>
      </header>

      <QuotaBlock
        title="5-hour window"
        window={account.fiveHour}
        nowMs={nowMs}
        onChange={(next) => updateWindow("fiveHour", next)}
      />
      <QuotaBlock
        title="Weekly window"
        window={account.weekly}
        nowMs={nowMs}
        onChange={(next) => updateWindow("weekly", next)}
      />

      <footer className="account-footer">
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
        <span>Updated {formatUpdatedAt(account.updatedAt)}</span>
      </footer>
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
      // Local storage may be unavailable. The dashboard remains usable in memory.
    }
  }, [accounts, ready]);

  const recommended = useMemo(
    () => (nowMs ? getRecommendedAccount(accounts, nowMs) : null),
    [accounts, nowMs],
  );

  const summary = useMemo(() => {
    if (!nowMs) {
      return { available: 0, weeklyMax: 0, fiveHourMax: 0, refresh: 0 };
    }

    return accounts.reduce(
      (acc, account) => {
        const status = getAccountStatus(account, nowMs);

        if (status === "available" || status === "low") acc.available += 1;
        if (status === "weekly_limited" || status === "exhausted") {
          acc.weeklyMax += 1;
        }
        if (status === "five_hour_limited" || status === "exhausted") {
          acc.fiveHourMax += 1;
        }
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
    const next = createDemoAccounts();
    setAccounts(next);
    setNowMs(Date.now());
  };

  if (!ready || !nowMs) {
    return (
      <main className="shell">
        <div className="loading-card">Loading local quota snapshots…</div>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="brand-row">
            <span className="brand-mark">Q</span>
            <span className="eyebrow">QuotaOps MVP</span>
          </div>
          <h1>Claude Team capacity</h1>
          <p className="intro">
            Track five independent accounts, their 5-hour windows, weekly caps,
            and exact reset times from one local-first dashboard.
          </p>
        </div>

        <button className="secondary-button" type="button" onClick={restoreDemo}>
          Restore demo data
        </button>
      </header>

      <section className="summary-grid" aria-label="Capacity summary">
        <div className="summary-card">
          <span>Available now</span>
          <strong>{summary.available} / {accounts.length}</strong>
        </div>
        <div className="summary-card">
          <span>Weekly max</span>
          <strong>{summary.weeklyMax}</strong>
        </div>
        <div className="summary-card">
          <span>5h blocked</span>
          <strong>{summary.fiveHourMax}</strong>
        </div>
        <div className="summary-card accent">
          <span>Best capacity</span>
          <strong>{recommended?.label ?? "None"}</strong>
        </div>
      </section>

      {summary.refresh > 0 ? (
        <div className="notice" role="status">
          {summary.refresh} account{summary.refresh === 1 ? "" : "s"} have reset
          timestamps in the past or missing data. QuotaOps will not assume new
          capacity until you refresh the snapshot.
        </div>
      ) : null}

      <section className="account-grid" aria-label="Claude accounts">
        {accounts.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            nowMs={nowMs}
            recommended={recommended?.id === account.id}
            onChange={updateAccount}
          />
        ))}
      </section>

      <footer className="privacy-note">
        <strong>Local-first MVP.</strong> This version stores only account labels,
        usage percentages, reset timestamps, and update times in this browser.
        No Claude passwords, session cookies, API keys, prompts, or conversations
        are collected.
      </footer>
    </main>
  );
}
