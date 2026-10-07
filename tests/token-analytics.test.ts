import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexTokenState,
  parseClaudeTokenRecord,
  parseCodexTokenRecord,
} from "../collector/token-analytics.ts";
import {
  summarizeTokenRange,
  type TokenAnalyticsSnapshot,
} from "../lib/token-analytics.ts";

test("parses Claude Code assistant usage and counts cache as observed input work", () => {
  const parsed = parseClaudeTokenRecord({
    type: "assistant",
    uuid: "message-1",
    timestamp: "2026-10-08T00:15:00.000Z",
    message: {
      usage: {
        input_tokens: 120,
        output_tokens: 80,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 300,
      },
    },
  });

  assert.equal(parsed?.id, "message-1");
  assert.equal(parsed?.date, "2026-10-08");
  assert.deepEqual(parsed?.totals, {
    inputTokens: 120,
    outputTokens: 80,
    cacheReadTokens: 500,
    cacheWriteTokens: 300,
    totalTokens: 1000,
  });
});

test("Claude iterations are summed instead of double-counting the mirrored top-level usage", () => {
  const parsed = parseClaudeTokenRecord({
    type: "assistant",
    uuid: "message-retry",
    timestamp: "2026-10-08T00:15:00.000Z",
    message: {
      usage: {
        input_tokens: 9999,
        output_tokens: 9999,
        iterations: [
          {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 40,
          },
          {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4,
          },
        ],
      },
    },
  });

  assert.deepEqual(parsed?.totals, {
    inputTokens: 11,
    outputTokens: 22,
    cacheReadTokens: 33,
    cacheWriteTokens: 44,
    totalTokens: 110,
  });
});

test("parses Codex last-token usage without double-counting cached input", () => {
  const state = createCodexTokenState();
  parseCodexTokenRecord(
    {
      timestamp: "2026-10-08T00:19:00.000Z",
      type: "session_meta",
      payload: { id: "session-1" },
    },
    state,
  );

  const parsed = parseCodexTokenRecord(
    {
      timestamp: "2026-10-08T00:20:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 2000,
            cached_input_tokens: 1500,
            output_tokens: 400,
          },
          last_token_usage: {
            input_tokens: 500,
            cached_input_tokens: 300,
            output_tokens: 100,
          },
        },
      },
    },
    state,
  );

  assert.equal(parsed?.date, "2026-10-08");
  assert.deepEqual(parsed?.totals, {
    inputTokens: 500,
    outputTokens: 100,
    cacheReadTokens: 300,
    cacheWriteTokens: 0,
    totalTokens: 600,
  });
});

test("suppresses replayed Codex parent history in child sessions", () => {
  const state = createCodexTokenState();

  assert.equal(
    parseCodexTokenRecord(
      {
        timestamp: "2026-10-08T00:00:00.000Z",
        type: "session_meta",
        payload: { id: "child", forked_from_id: "parent" },
      },
      state,
    ),
    null,
  );

  assert.equal(
    parseCodexTokenRecord(
      {
        timestamp: "2026-10-08T00:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 600,
              output_tokens: 100,
            },
          },
        },
      },
      state,
    ),
    null,
  );

  assert.equal(
    parseCodexTokenRecord(
      {
        timestamp: "2026-10-08T00:00:05.000Z",
        type: "event_msg",
        payload: { type: "task_started", started_at: 1791417605 },
      },
      state,
    ),
    null,
  );

  const live = parseCodexTokenRecord(
    {
      timestamp: "2026-10-08T00:00:06.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1100,
            cached_input_tokens: 650,
            output_tokens: 130,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 50,
            output_tokens: 30,
          },
        },
      },
    },
    state,
  );

  assert.equal(live?.totals.totalTokens, 130);
});

test("range summaries aggregate providers without treating cached Codex input as extra total tokens", () => {
  const analytics: TokenAnalyticsSnapshot = {
    generatedAt: "2026-10-08T12:00:00.000Z",
    scope: "locally_observed",
    totals: {
      inputTokens: 550,
      outputTokens: 160,
      cacheReadTokens: 330,
      cacheWriteTokens: 40,
      totalTokens: 780,
    },
    providers: [
      {
        provider: "claude",
        totals: {
          inputTokens: 50,
          outputTokens: 60,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
          totalTokens: 180,
        },
      },
      {
        provider: "openai",
        totals: {
          inputTokens: 500,
          outputTokens: 100,
          cacheReadTokens: 300,
          cacheWriteTokens: 0,
          totalTokens: 600,
        },
      },
    ],
    daily: [
      {
        date: "2026-09-01",
        provider: "claude",
        inputTokens: 50,
        outputTokens: 60,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        totalTokens: 180,
      },
      {
        date: "2026-10-08",
        provider: "openai",
        inputTokens: 500,
        outputTokens: 100,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
        totalTokens: 600,
      },
    ],
    sources: [],
  };

  const today = summarizeTokenRange(
    analytics,
    "today",
    Date.parse("2026-10-08T12:00:00.000Z"),
  );
  assert.equal(today.totals.totalTokens, 600);
  assert.equal(today.totals.cacheReadTokens, 300);
  assert.deepEqual(today.providers.map((item) => item.provider), ["openai"]);

  const all = summarizeTokenRange(
    analytics,
    "all",
    Date.parse("2026-10-08T12:00:00.000Z"),
  );
  assert.equal(all.totals.totalTokens, 780);
  assert.equal(all.providers.length, 2);
});
