import assert from "node:assert/strict";
import test from "node:test";

import { parseVoiceUsageCommand } from "../lib/voice-command.ts";
import type { QuotaAccount } from "../lib/quota.ts";

const accounts: QuotaAccount[] = [
  {
    id: "dev-1",
    label: "Dev 1",
    provider: "claude",
    plan: "team",
    fiveHour: { usedPercent: 10, resetAt: null },
    weekly: { usedPercent: 20, resetAt: null },
    updatedAt: "2026-10-06T10:00:00.000Z",
  },
];

test("parses an English weekly voice command", () => {
  const command = parseVoiceUsageCommand("Dev 1 weekly 82", accounts);
  assert.equal(command?.accountId, "dev-1");
  assert.equal(command?.window, "weekly");
  assert.equal(command?.usedPercent, 82);
});

test("parses a five-hour voice command", () => {
  const command = parseVoiceUsageCommand("Dev 1 five hour 40", accounts);
  assert.equal(command?.window, "fiveHour");
  assert.equal(command?.usedPercent, 40);
});

test("accepts a Greek weekly keyword", () => {
  const command = parseVoiceUsageCommand("Dev 1 εβδομαδιαίο 65", accounts);
  assert.equal(command?.window, "weekly");
  assert.equal(command?.usedPercent, 65);
});

test("rejects a command without a known account", () => {
  assert.equal(parseVoiceUsageCommand("Dev 2 weekly 50", accounts), null);
});
