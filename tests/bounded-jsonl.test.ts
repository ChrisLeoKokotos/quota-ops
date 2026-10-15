import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedJsonl, MAX_JSONL_LINE_BYTES } from "../collector/bounded-jsonl.ts";

test("bounded JSONL reads ordinary records and skips malformed lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quotaops-jsonl-"));
  try {
    const path = join(dir, "events.jsonl");
    await writeFile(path, '{"type":"assistant","value":1}\nnot-json\n{"type":"event_msg","value":2}\r\n');
    const records: Record<string, unknown>[] = [];
    assert.equal(await readBoundedJsonl(path, (record) => records.push(record)), true);
    assert.deepEqual(records.map((record) => record.value), [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded JSONL rejects oversized unbroken lines before parsing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quotaops-jsonl-"));
  try {
    const path = join(dir, "oversize.jsonl");
    await writeFile(path, "x".repeat(MAX_JSONL_LINE_BYTES + 1));
    let calls = 0;
    assert.equal(await readBoundedJsonl(path, () => { calls += 1; }), false);
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded JSONL fails closed on a missing file", async () => {
  assert.equal(await readBoundedJsonl(join(tmpdir(), "quotaops-nonexistent-security-file.jsonl"), () => {}), false);
});

test("bounded JSONL stops a scan once the caller's budget is exhausted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quotaops-jsonl-"));
  try {
    const path = join(dir, "many.jsonl");
    const lines = Array.from(
      { length: 500 },
      (_unused, index) => JSON.stringify({ value: index }),
    );
    await writeFile(path, lines.join("\n") + "\n");

    const records: Record<string, unknown>[] = [];
    const ok = await readBoundedJsonl(
      path,
      (record) => records.push(record),
      { shouldStop: () => records.length >= 10 },
    );

    // A cancelled file is reported incomplete so the caller marks it partial.
    assert.equal(ok, false);
    assert.equal(records.length, 10);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded JSONL refuses a file when the budget is already spent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quotaops-jsonl-"));
  try {
    const path = join(dir, "events.jsonl");
    await writeFile(path, '{"value":1}\n{"value":2}\n');

    let calls = 0;
    const ok = await readBoundedJsonl(
      path,
      () => { calls += 1; },
      { shouldStop: () => true },
    );

    assert.equal(ok, false);
    assert.equal(calls, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bounded JSONL still completes when the budget is never exhausted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quotaops-jsonl-"));
  try {
    const path = join(dir, "events.jsonl");
    await writeFile(path, '{"value":1}\n{"value":2}\n');

    const records: Record<string, unknown>[] = [];
    const ok = await readBoundedJsonl(
      path,
      (record) => records.push(record),
      { shouldStop: () => false },
    );

    assert.equal(ok, true);
    assert.deepEqual(records.map((record) => record.value), [1, 2]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
