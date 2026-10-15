import assert from "node:assert/strict";
import test from "node:test";

import {
  createDefaultCollectorConfig,
  migrateConsent,
} from "../collector/config.ts";
import { collectLocalTokenAnalytics } from "../collector/token-analytics.ts";

test("background token scanning is disabled by default", () => {
  assert.equal(createDefaultCollectorConfig().tokenAnalyticsEnabled, false);
});

test("a fresh configuration consents to neither history source", () => {
  const config = createDefaultCollectorConfig();

  assert.deepEqual(config.tokenAnalyticsSources, {
    claudeCode: false,
    codex: false,
  });
});

test("collector default uses a fixed loopback port", () => {
  const config = createDefaultCollectorConfig();
  assert.equal(config.port, 4317);
  assert.equal(config.accounts.length, 0);
});

test("a pre-consent configuration migrates to opted out", () => {
  assert.deepEqual(migrateConsent({ version: 1 }), {
    claudeCode: false,
    codex: false,
  });
  assert.deepEqual(migrateConsent({ tokenAnalyticsEnabled: false }), {
    claudeCode: false,
    codex: false,
  });
});

test("a configuration that had already opted in keeps both sources", () => {
  assert.deepEqual(migrateConsent({ tokenAnalyticsEnabled: true }), {
    claudeCode: true,
    codex: true,
  });
});

test("an explicit per-source choice survives migration untouched", () => {
  assert.deepEqual(
    migrateConsent({
      tokenAnalyticsEnabled: true,
      tokenAnalyticsSources: { claudeCode: false, codex: true },
    }),
    { claudeCode: false, codex: true },
  );
});

test("a malformed consent record falls back to the legacy switch", () => {
  for (const malformed of [null, "yes", 1, {}, { claudeCode: true }]) {
    assert.deepEqual(
      migrateConsent({
        tokenAnalyticsEnabled: false,
        tokenAnalyticsSources: malformed,
      }),
      { claudeCode: false, codex: false },
    );
  }
});

test("a scan with no consent reads nothing and reports both sources off", async () => {
  // Both sources are skipped, so this touches no file in the user's home.
  const snapshot = await collectLocalTokenAnalytics({
    claudeCode: false,
    codex: false,
  });

  assert.equal(snapshot.scope, "locally_observed");
  assert.deepEqual(snapshot.providers, []);
  assert.deepEqual(snapshot.daily, []);
  assert.equal(snapshot.totals.totalTokens, 0);
  assert.deepEqual(
    snapshot.sources.map((source) => [source.source, source.state]),
    [
      ["claude-code", "disabled"],
      ["codex", "disabled"],
    ],
  );
});

test("an unread source is never reported as not_found", async () => {
  const snapshot = await collectLocalTokenAnalytics({
    claudeCode: false,
    codex: false,
  });

  // `not_found` would claim QuotaOps looked and the files were absent.
  for (const source of snapshot.sources) {
    assert.notEqual(source.state, "not_found");
    assert.equal(source.files, 0);
    assert.match(String(source.message), /did not read these files/);
  }
});

test("a disabled-source snapshot carries no file paths or history text", async () => {
  const snapshot = await collectLocalTokenAnalytics({
    claudeCode: false,
    codex: false,
  });
  const serialized = JSON.stringify(snapshot);

  for (const forbidden of [
    ".jsonl",
    ".claude",
    ".codex",
    "projects",
    "sessions",
    "Users",
    "C:\\",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `snapshot must not expose ${forbidden}`,
    );
  }
});
