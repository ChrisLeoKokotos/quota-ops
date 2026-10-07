import assert from "node:assert/strict";
import test from "node:test";

import { parseVoiceUsageCommand } from "../lib/voice-command.ts";
import type { QuotaAccount } from "../lib/quota.ts";

const accounts: QuotaAccount[] = [
  {
    id: "dev-1",
    label: "Dev 1",
    provider: "claude",
    plan: "Team",
    windows: [
      { id: "five-hour", label: "5-hour", usedPercent: 10, resetAt: null },
      { id: "weekly", label: "Weekly", usedPercent: 20, resetAt: null },
    ],
    updatedAt: "2026-10-06T10:00:00.000Z",
  },
];

test("parses an English weekly voice command", () => {
  const command = parseVoiceUsageCommand("Dev 1 weekly 82", accounts);
  assert.equal(command?.accountId, "dev-1");
  assert.equal(command?.windowId, "weekly");
  assert.equal(command?.usedPercent, 82);
});

test("parses a five-hour voice command", () => {
  const command = parseVoiceUsageCommand("Dev 1 five hour 40", accounts);
  assert.equal(command?.windowId, "five-hour");
  assert.equal(command?.usedPercent, 40);
});

test("accepts a Greek weekly keyword", () => {
  const command = parseVoiceUsageCommand("Dev 1 εβδομαδιαίο 65", accounts);
  assert.equal(command?.windowId, "weekly");
  assert.equal(command?.usedPercent, 65);
});

test("rejects a command without a known account", () => {
  assert.equal(parseVoiceUsageCommand("Dev 2 weekly 50", accounts), null);
});

test("does not mistake the account number or numeric 5-hour marker for usage", () => {
  const command = parseVoiceUsageCommand("Dev 1 5 hour 40", accounts);
  assert.equal(command?.windowId, "five-hour");
  assert.equal(command?.usedPercent, 40);
});

test("accepts the percentage before the account and quota window", () => {
  const command = parseVoiceUsageCommand("Set 82 for Dev 1 weekly", accounts);
  assert.equal(command?.windowId, "weekly");
  assert.equal(command?.usedPercent, 82);
});

test("rejects ambiguous commands with multiple possible percentages", () => {
  assert.equal(
    parseVoiceUsageCommand("Dev 1 weekly 50 then 60", accounts),
    null,
  );
});
