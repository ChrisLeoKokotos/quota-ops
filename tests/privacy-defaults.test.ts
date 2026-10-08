import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultCollectorConfig } from "../collector/config.ts";

test("background token scanning is disabled by default", () => {
  assert.equal(createDefaultCollectorConfig().tokenAnalyticsEnabled, false);
});

test("collector default uses a fixed loopback port", () => {
  const config = createDefaultCollectorConfig();
  assert.equal(config.port, 4317);
  assert.equal(config.accounts.length, 0);
});
