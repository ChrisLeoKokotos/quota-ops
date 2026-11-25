import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { watchFile, unwatchFile } from "node:fs";
import { randomUUID } from "node:crypto";

import { collectProviderUsage } from "./provider.ts";
import { collectLocalTokenAnalytics, resetTokenScanCache, tokenScanPending } from "./token-analytics.ts";
import { TokenRunner } from "./token-runner.ts";
import { mergeGoogleAnalytics } from "./google-analytics.ts";
import { MonitoringController } from "./monitoring.ts";
import { createCollectorShutdown } from "./shutdown.ts";
import {
  AttentionHolds,
  loadHolds,
  persistHolds,
  type RefreshTrigger,
} from "./attention-hold.ts";
import { getCollectorRunDir, getCollectorStatePath, getCollectorConfigPath } from "./paths.ts";
import { collectInHiddenDesktop, hiddenDesktopSupported } from "./hidden-desktop.ts";
import { CollectionCancelledError } from "./browser-session.ts";
import { openProfileForPerson, type InteractiveProfile } from "./manual-verification.ts";
import { loadCollectorConfig, updateCollectorConfig, withCollectorConfig, tokenConsentKey as consentKey } from "./config.ts";
import {
  collectorTokenMatches,
  getOrCreateCollectorToken,
} from "./security.ts";
import type {
  CollectorAccountResult,
  CollectorSnapshotResponse,
} from "./types.ts";

const HOST = "127.0.0.1";
const MAX_REQUESTS_PER_MINUTE = 120;

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cross-Origin-Resource-Policy", "same-site");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.end(JSON.stringify(value));
}

function suppliedBearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice("Bearer ".length).trim();
}

async function main(): Promise<void> {
  const config = await loadCollectorConfig();
  const collectorToken = await getOrCreateCollectorToken();
  let results: CollectorAccountResult[] = [];
  // Token analytics has its own clock (token-runner.ts): provider checks that
  // fail, wait for a person, are paused or switched off never hold it back.
  // Local private histories are read only with the stored consent.
  let observedConsent = consentKey(config);
  let consentChanging = false;
  const tokens: TokenRunner = new TokenRunner({
    clearCache: resetTokenScanCache,
    scan: async (signal) => {
      const current = await loadCollectorConfig();
      signal.throwIfAborted();
      if (consentKey(current) !== observedConsent) {
        observedConsent = consentKey(current);
        tokens.invalidate();
        return null;
      }
      if (!current.tokenAnalyticsEnabled) return null;
      const sources = current.tokenAnalyticsSources;
      if (!sources.claudeCode && !sources.codex && sources.googleAntigravity !== true) return null;
      const snapshot = await mergeGoogleAnalytics(
        await collectLocalTokenAnalytics(sources, signal),
        current.accounts, sources.googleAntigravity === true,
      );
      signal.throwIfAborted();
      // CLI consent changes are also observed before any scan is published.
      const latest = await loadCollectorConfig().catch(() => null);
      signal.throwIfAborted();
      if (!latest) {
        if (observedConsent !== "invalid") {
          observedConsent = "invalid";
          tokens.invalidate();
        }
        return null;
      }
      if (consentKey(latest) !== consentKey(current)) {
        observedConsent = consentKey(latest);
        tokens.invalidate();
        return null;
      }
      return { snapshot, pending: tokenScanPending() };
    },
  });
  // A disabled runner has no periodic timer. Watch config changes so CLI
  // revocation or opt-in is noticed even while provider monitoring is paused.
  const consentPath = getCollectorConfigPath();
  let observation = 0;
  const observeConsent = async () => {
    const version = ++observation;
    let key: string;
    try { key = consentKey(await loadCollectorConfig()); }
    catch { key = "invalid"; }
    if (version !== observation || key === observedConsent) return;
    observedConsent = key;
    tokens.invalidate();
  };
  watchFile(consentPath, { interval: 1000, persistent: false }, () => { void observeConsent(); });
  // generatedAt is a provider collection timestamp, not the time a client
  // retrieved a cached /snapshot (which can be many minutes old).
  let generatedAt = new Date(0).toISOString();

  // Accounts waiting for a person (challenge / signed out) are not retried by
  // scheduled cycles; see attention-hold.ts (issue #49).
  const holds = new AttentionHolds();
  const statePath = getCollectorStatePath();
  await loadHolds(holds, statePath, new Map(config.accounts.map((account) => [account.id, account.label])));
  // Show restored holds at once (tray "Needs your attention", dashboard
  // state) instead of waiting for a batch, which may never run when
  // background collection is off.
  // Every enabled account is visible from the first snapshot: restored
  // holds as they were, everything else as "configured" (not checked yet).
  // A failed or pending check never turns into a usage value.
  const configuredResult = (account: { id: string; label: string }): CollectorAccountResult => ({
    id: account.id,
    label: account.label,
    status: "configured",
    account: null,
    checkedAt: new Date(0).toISOString(),
    message: "Not checked yet in this session.",
  });
  const withLastSuccess = (result: CollectorAccountResult): CollectorAccountResult => ({
    ...result,
    lastSuccessAt: holds.lastSuccessAt(result.id),
  });
  {
    const enabledAtStart = config.accounts.filter((account) => account.enabled);
    const held = new Map(holds.heldResults(enabledAtStart).map((result) => [result.id, result]));
    results = enabledAtStart.map((account) => withLastSuccess(held.get(account.id) ?? configuredResult(account)));
  }
  const interactiveProfiles = new Map<string, InteractiveProfile>();

  const monitoring = new MonitoringController(
    async (invalidated, signal, trigger: RefreshTrigger) => {
      const current = await loadCollectorConfig();
      // Unattended collection switched off: only a person's request collects.
      if (trigger === "scheduled" && current.backgroundCollection === "off") return null;
      const enabled = current.accounts.filter((account) => account.enabled);
      const nextResults: CollectorAccountResult[] = [];
      // Only a consented, person-initiated refresh may show a browser window
      // on the person's screen. Everything else is "hidden" (Windows: an
      // ordinary browser on a never-shown desktop) or headless.
      const visible = trigger === "visible";
      const hidden = !visible && current.backgroundCollection !== "headless" && hiddenDesktopSupported();
      if (hidden) {
        try {
          const slots: Array<{ result: CollectorAccountResult | null; account: (typeof enabled)[number] }> = [];
          const browserAccounts: typeof enabled = [];
          for (const account of enabled) {
            if (invalidated()) return null;
            const held = holds.skip(account, trigger, "hidden");
            if (held) { slots.push({ account, result: held }); continue; }
            if (account.provider === "google") {
              const result = await collectProviderUsage(account, { signal });
              if (!invalidated()) holds.record(result, "hidden");
              slots.push({ account, result });
              continue;
            }
            slots.push({ account, result: null });
            browserAccounts.push(account);
          }
          const collected = await collectInHiddenDesktop(browserAccounts, { signal, runDir: getCollectorRunDir() });
          if (invalidated()) return null;
          const byId = new Map(collected.map((result) => [result.id, result]));
          for (const slot of slots) {
            const result = slot.result ?? byId.get(slot.account.id);
            if (!result) continue;
            if (!slot.result) holds.record(result, "hidden");
            nextResults.push(result);
          }
        } catch (error) {
          if (error instanceof CollectionCancelledError) return null;
          throw error;
        } finally {
          await persistHolds(holds, statePath);
        }
      }

      // Holds changed earlier in this batch are saved even when Quit or
      // Pause stops it part-way.
      if (!hidden) try {
        for (const account of enabled) {
          if (invalidated()) return null;
          const held = holds.skip(account, trigger, "headless");
          if (held) {
            nextResults.push(held);
            continue;
          }
          // The signal aborts on shutdown and closes this account's profile.
          const result = await collectProviderUsage(account, { signal, visible });
          if (!invalidated()) holds.record(result, visible ? "visible" : "headless");
          nextResults.push(result);
        }
      } finally {
        await persistHolds(holds, statePath);
      }
      if (invalidated()) return null;
      return { nextResults };
    },
    (value, at) => {
      if (value === null) return;
      results = value.nextResults.map(withLastSuccess);
      // Do not report a fresh collection when no account produced usage:
      // a batch in which every account failed refreshed nothing (issue #49).
      if (value.nextResults.length === 0 ||
          value.nextResults.some((result) => result.status === "ok")) {
        generatedAt = at;
      }
    },
  );

  const snapshot = (): CollectorSnapshotResponse => ({
    version: 1,
    generatedAt,
    accounts: results,
    tokens: tokens.snapshot,
    tokenStatus: tokens.status,
  });

  /**
   * POST /accounts/verify?id=<account id>: open that account's isolated
   * profile in the normal browser for a person to sign in or verify. Only an
   * id from the local config is accepted; nothing else comes from the request.
   * Automation stays off the profile until the window closes, then checks the
   * account once.
   */
  const openForVerification = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    let id: string | null = null;
    try {
      const url = new URL(request.url ?? "", `http://${HOST}`);
      if (url.pathname === "/accounts/verify" && [...url.searchParams.keys()].length === 1) {
        id = url.searchParams.get("id");
      }
    } catch {
      id = null;
    }
    if (!id || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
      sendJson(request, response, 400, { error: "invalid_account" });
      return;
    }
    let account;
    try {
      account = (await loadCollectorConfig()).accounts.find(
        (candidate) => candidate.id === id && candidate.enabled,
      );
    } catch {
      account = undefined;
    }
    if (!account) {
      sendJson(request, response, 404, { error: "unknown_account" });
      return;
    }
    // Never open a profile a running collection may be using.
    if (monitoring.status().collecting) {
      sendJson(request, response, 409, { error: "collection_in_progress" });
      return;
    }
    if (!holds.beginInteractive(account.id)) {
      sendJson(request, response, 409, { error: "already_open" });
      return;
    }
    try {
      const opened = await openProfileForPerson(account);
      interactiveProfiles.set(account.id, opened);
      void opened.exited.then(() => {
        interactiveProfiles.delete(account.id);
        holds.endInteractive(account.id);
        monitoring.queueRefresh("manual");
      });
      sendJson(request, response, 202, { status: "opened" });
    } catch {
      holds.endInteractive(account.id);
      sendJson(request, response, 503, { error: "browser_unavailable" });
    }
  };

  /**
   * POST /token-analytics/consent?claude-code=0|1&codex=0|1: the person's
   * choice from the desktop app (after a dialog that says what is read).
   * Antigravity numeric counters keep their own, separate opt-in. The new
   * totals are computed at once instead of waiting for the next check.
   */
  const setTokenConsent = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let claudeCode: boolean | null = null;
    let codex: boolean | null = null;
    try {
      const url = new URL(request.url ?? "", `http://${HOST}`);
      const keys = [...url.searchParams.keys()].sort().join(",");
      const flag = (value: string | null) => (value === "1" ? true : value === "0" ? false : null);
      if (url.pathname === "/token-analytics/consent" && keys === "claude-code,codex") {
        claudeCode = flag(url.searchParams.get("claude-code"));
        codex = flag(url.searchParams.get("codex"));
      }
    } catch {
      claudeCode = null;
    }
    if (claudeCode === null || codex === null) {
      sendJson(request, response, 400, { error: "invalid_consent" });
      return;
    }
    if (consentChanging) {
      sendJson(request, response, 409, { error: "consent_change_in_progress" });
      return;
    }
    consentChanging = true;
    try {
      const flags = { claudeCode, codex };
      const next = await updateCollectorConfig(current => {
        const { claudeCode, codex } = flags;
        const sources = { ...current.tokenAnalyticsSources, claudeCode, codex };
        return {
          ...current,
          tokenAnalyticsSources: sources,
          tokenConsentRevision: randomUUID(),
          tokenAnalyticsEnabled: claudeCode || codex || sources.googleAntigravity === true,
        };
      });
      observation++;
      observedConsent = consentKey(next);
      tokens.invalidate();
      // Start (or stop) at once; the first pass of a large history can take
      // several seconds, so the reply does not wait for it. The snapshot says
      // "scanning" until the pass returns.
      sendJson(request, response, 200, { status: "ok", claudeCode, codex });
    } catch {
      sendJson(request, response, 500, { error: "consent_not_saved" });
    } finally {
      consentChanging = false;
    }
  };

  let rateWindowStartedAt = Date.now();
  let requestCount = 0;

  const server = createServer((request, response) => {
    const expectedHost = `${HOST}:${config.port}`;
    if (request.headers.host !== expectedHost) {
      sendJson(request, response, 400, { error: "invalid_host" });
      return;
    }

    if (request.headers.origin) {
      sendJson(request, response, 403, { error: "browser_direct_access_denied" });
      return;
    }

    if (!collectorTokenMatches(collectorToken, suppliedBearerToken(request))) {
      sendJson(request, response, 401, { error: "unauthorized" });
      return;
    }

    const now = Date.now();
    if (now - rateWindowStartedAt >= 60_000) {
      rateWindowStartedAt = now;
      requestCount = 0;
    }

    requestCount += 1;
    if (requestCount > MAX_REQUESTS_PER_MINUTE) {
      sendJson(request, response, 429, { error: "rate_limited" });
      return;
    }

    // Explicit POST operations require exactly the same authenticated
    // loopback boundary as reads. The renderer has no IPC method for them.
    if (request.method === "POST") {
      if (request.url === "/monitoring/pause") {
        monitoring.pause();
        sendJson(request, response, 200, { status: "ok", ...monitoring.status() });
        return;
      }
      if (request.url === "/monitoring/resume") {
        monitoring.resume();
        sendJson(request, response, 200, { status: "ok", ...monitoring.status() });
        return;
      }
      if (request.url === "/monitoring/refresh") {
        // A person asked: held accounts are tried once more.
        const queued = monitoring.queueRefresh("manual");
        sendJson(request, response, queued ? 202 : 409, {
          status: queued ? "accepted" : "paused", ...monitoring.status(),
        });
        return;
      }
      if (request.url?.startsWith("/token-analytics/consent?")) {
        void setTokenConsent(request, response);
        return;
      }
      if (request.url === "/monitoring/refresh-visible") {
        // Main process asks only after the person confirmed a dialog that
        // says browser windows will open and may take focus.
        // Nothing is remembered when this is refused (paused): a consented
        // visible request never runs later.
        const queued = monitoring.queueRefresh("visible");
        sendJson(request, response, queued ? 202 : 409, {
          status: queued ? "accepted" : "paused", ...monitoring.status(),
        });
        return;
      }
      if (request.url?.startsWith("/accounts/verify?")) {
        void openForVerification(request, response);
        return;
      }
      sendJson(request, response, 404, { error: "not_found" });
      return;
    }

    if (request.method !== "GET") {
      sendJson(request, response, 405, { error: "method_not_allowed" });
      return;
    }

    if (request.url === "/health") {
      sendJson(request, response, 200, {
        status: "ok",
        ...monitoring.status(),
      });
      return;
    }

    if (request.url === "/snapshot") {
      // The watcher is intentionally asynchronous. Do not publish cached token
      // totals in its blind interval after a CLI revocation. Queue the response
      // under the same lock as consent mutations, then release it immediately.
      void withCollectorConfig(current => {
        const key = consentKey(current);
        if (key !== observedConsent) {
          observation++;
          observedConsent = key;
          tokens.invalidate();
        }
        const value = snapshot();
        sendJson(request, response, 200, current.tokenAnalyticsEnabled ? value : {
          ...value, tokens: null,
          tokenStatus: { state: "disabled", scannedAt: null, pending: false },
        });
      }).catch(() => {
        if (response.headersSent || response.destroyed) return;
        if (observedConsent !== "invalid") {
          observation++;
          observedConsent = "invalid";
          tokens.invalidate();
        }
        // An invalid or busy configuration must not expose cached private
        // aggregates; provider quota data remains separately available.
        sendJson(request, response, 200, {
          ...snapshot(), tokens: null,
          tokenStatus: { state: "unavailable", scannedAt: null, pending: false },
        });
      });
      return;
    }

    sendJson(request, response, 404, { error: "not_found" });
  });

  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;

  // Port 4317 already taken (another QuotaOps collector, or something else):
  // exit with a code the desktop app understands instead of crashing.
  server.on("error", (error: NodeJS.ErrnoException) => {
    process.stderr.write(`QuotaOps collector could not listen: ${error.code ?? "error"}\n`);
    process.exit(error.code === "EADDRINUSE" ? 5 : 6);
  });
  server.listen(config.port, HOST, () => {
    process.stdout.write(
      `QuotaOps collector listening on http://${HOST}:${config.port}\n`,
    );
  });

  // Scheduled ticks honour backgroundCollection at the time they fire.
  const scheduledTick = () => {
    void loadCollectorConfig()
      .then((current) => {
        if (current.backgroundCollection !== "off") monitoring.queueRefresh("scheduled");
      })
      .catch(() => undefined);
  };
  scheduledTick();
  const timer = setInterval(scheduledTick, config.pollIntervalSeconds * 1000);
  void tokens.trigger();

  // Bounded: cancels the in-flight provider browser, drains for a few
  // seconds, closes the listener and its keep-alive sockets, then exits.
  // The utility parentPort may keep the event loop alive, hence exit().
  const shutdown = createCollectorShutdown({
    monitoring,
    server,
    stopScheduling: () => {
      clearInterval(timer);
      unwatchFile(consentPath);
      observation++;
      tokens.stop();
    },
    closeInteractive: () => {
      for (const profile of interactiveProfiles.values()) profile.close();
    },
    exit: (code) => process.exit(code),
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // The installed Electron app owns the collector utility process and asks it
  // to drain on Quit. The renderer has no access to this process channel.
  const utilityParent = (process as NodeJS.Process & {
    parentPort?: {
      on(event: "message", callback: (event: { data: unknown }) => void): void;
    };
  }).parentPort;
  utilityParent?.on("message", (event) => {
    const data = event.data;
    if (data && typeof data === "object" &&
        "action" in data && data.action === "shutdown") shutdown();
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `QuotaOps collector failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
