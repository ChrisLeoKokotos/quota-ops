import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleModelGroupWindows, hasGoogleModelGroup, normalizeGoogleModelGroup } from "../lib/google-manual.ts";
import { getAccountStatus, getRecommendedAccount, providerLabel, type QuotaAccount } from "../lib/quota.ts";

const NOW = Date.parse("2026-11-19T12:00:00.000Z");
const RESET = "2026-11-20T12:00:00.000Z";

test("Google / Antigravity is a first-class provider label", () => {
  assert.equal(providerLabel("google"), "Google / Antigravity");
  assert.equal(providerLabel("claude"), "Claude");
  assert.equal(providerLabel("openai"), "OpenAI");
});

test("creates two separate model quota windows and does not invent reset times", () => {
  const windows = createGoogleModelGroupWindows(" Gemini  Pro ", 28.5, RESET, 64, null);
  assert.deepEqual(windows.map((w) => w.label), ["Gemini Pro · 5-hour", "Gemini Pro · Weekly"]);
  assert.equal(windows[0]?.usedPercent, 28.5);
  assert.equal(windows[1]?.resetAt, null);
  assert.equal(hasGoogleModelGroup(windows, "gemini pro"), true);
  assert.equal(hasGoogleModelGroup(windows, "Gemini Flash"), false);
});

test("rejects invalid names and distinguishes independent model groups", () => {
  assert.equal(normalizeGoogleModelGroup(" "), null);
  assert.equal(normalizeGoogleModelGroup("a".repeat(61)), null);
  assert.equal(normalizeGoogleModelGroup("abc\u0000def"), null);
  assert.throws(() => createGoogleModelGroupWindows("", 0, null, 0, null));
  const a = createGoogleModelGroupWindows("Gemini Pro", 20, RESET, 30, RESET);
  const b = createGoogleModelGroupWindows("Gemini Flash", 5, RESET, 10, RESET);
  assert.equal(new Set([...a, ...b].map((w) => w.id)).size, 4);
});

test("manual Google account is never recommended on unknown reset and can be recommended after entry", () => {
  const google: QuotaAccount = {
    id: "manual-google", provider: "google", plan: "Antigravity",
    label: "Google 1", source: "manual",
    windows: createGoogleModelGroupWindows("Gemini Pro", 0, null, 0, null),
    updatedAt: new Date(NOW).toISOString(),
  };
  assert.equal(getAccountStatus(google, NOW), "needs_setup");
  assert.equal(getRecommendedAccount([google], NOW), null);
  google.windows = createGoogleModelGroupWindows("Gemini Pro", 20, RESET, 35, RESET);
  assert.equal(getAccountStatus(google, NOW), "available");
  assert.equal(getRecommendedAccount([google], NOW)?.id, google.id);
  google.windows.push(...createGoogleModelGroupWindows("Gemini Flash", 0, null, 0, null));
  assert.equal(getAccountStatus(google, NOW), "needs_setup");
});
