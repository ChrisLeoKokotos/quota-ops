import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import test, { afterEach } from "node:test";

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DESCRIPTOR_VERSION,
  INSTANCE_PATH,
  createInstanceId,
  isDescriptor,
  probeDescriptor,
  readDescriptor,
  removeOwnDescriptorSync,
  writeDescriptor,
  type DashboardDescriptor,
} from "../lib/dashboard-descriptor.ts";

/**
 * The descriptor is a discovery aid, not a credential. These tests pin the
 * property that matters: a reader must never conclude "QuotaOps is here"
 * from the file alone.
 */

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
    await once(server, "close").catch(() => undefined);
  }
});

async function startInstance(body: unknown, status = 200): Promise<number> {
  const server = createServer((request, response) => {
    if ((request.url ?? "").split("?")[0] !== INSTANCE_PATH) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json");
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  });

  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

function descriptorFor(port: number, instanceId: string): DashboardDescriptor {
  return {
    version: DESCRIPTOR_VERSION,
    port,
    pid: process.pid,
    instanceId,
    startedAt: "2026-10-15T12:00:00.000Z",
  };
}

test("a descriptor is confirmed only when the listener echoes its instance id", async () => {
  const instanceId = createInstanceId();
  const port = await startInstance({ instanceId, pid: process.pid, port: 0 });

  const result = await probeDescriptor(descriptorFor(port, instanceId));

  assert.equal(result.state, "live");
});

test("a listener belonging to something else is reported stale", async () => {
  const port = await startInstance({ instanceId: createInstanceId() });

  const result = await probeDescriptor(descriptorFor(port, createInstanceId()));

  assert.equal(result.state, "stale");
  assert.match(
    result.state === "stale" ? result.reason : "",
    /not the recorded instance/,
  );
});

test("a descriptor pointing at a dead port is stale, not live", async () => {
  // A crash leaves the file behind; nothing answers on the recorded port.
  const instanceId = createInstanceId();
  const port = await startInstance({ instanceId });
  const descriptor = descriptorFor(port, instanceId);

  for (const server of servers.splice(0)) {
    server.close();
    await once(server, "close");
  }

  const result = await probeDescriptor(descriptor, 1_000);

  assert.equal(result.state, "stale");
  assert.match(
    result.state === "stale" ? result.reason : "",
    /no listener answered/,
  );
});

test("an unrelated HTTP server on the recorded port is stale", async () => {
  // Port numbers are reused; another process answering 404 is not QuotaOps.
  const port = await startInstance({ instanceId: createInstanceId() }, 404);

  const result = await probeDescriptor(descriptorFor(port, createInstanceId()));

  assert.equal(result.state, "stale");
});

test("a malformed instance body is stale rather than trusted", async () => {
  const port = await startInstance("{not json");

  const result = await probeDescriptor(descriptorFor(port, createInstanceId()));

  assert.equal(result.state, "stale");
  assert.match(
    result.state === "stale" ? result.reason : "",
    /malformed/,
  );
});

test("a missing descriptor is absent, not live", async () => {
  assert.deepEqual(await probeDescriptor(null), { state: "absent" });
});

test("the descriptor shape is validated before use", () => {
  const valid = descriptorFor(3000, createInstanceId());
  assert.equal(isDescriptor(valid), true);

  for (const invalid of [
    null,
    "string",
    { ...valid, version: 2 },
    { ...valid, port: 0 },
    { ...valid, port: 70_000 },
    { ...valid, port: 1.5 },
    { ...valid, pid: -1 },
    { ...valid, instanceId: "short" },
    { ...valid, instanceId: 42 },
    { ...valid, startedAt: 0 },
  ]) {
    assert.equal(
      isDescriptor(invalid),
      false,
      `expected ${JSON.stringify(invalid)} to be rejected`,
    );
  }
});

test("the descriptor carries no secret material", () => {
  const serialized = JSON.stringify(descriptorFor(4100, createInstanceId()));

  for (const forbidden of [
    "capability",
    "secret",
    "token",
    "Bearer",
    "marker",
    "qo1.",
  ]) {
    assert.equal(
      serialized.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `the descriptor must not contain ${forbidden}`,
    );
  }
});

test("the exit backstop removes our descriptor and leaves another's alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quotaops-descriptor-"));
  const previous = process.env.QUOTAOPS_DESCRIPTOR_PATH;
  process.env.QUOTAOPS_DESCRIPTOR_PATH = join(directory, "dashboard-runtime.json");

  try {
    const ours = createInstanceId();
    await writeDescriptor(descriptorFor(12_345, ours));

    // A restarted instance must never delete a live instance's record.
    removeOwnDescriptorSync(createInstanceId());
    assert.notEqual(await readDescriptor(), null);

    removeOwnDescriptorSync(ours);
    assert.equal(await readDescriptor(), null);
  } finally {
    if (previous === undefined) delete process.env.QUOTAOPS_DESCRIPTOR_PATH;
    else process.env.QUOTAOPS_DESCRIPTOR_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a descriptor is written atomically and readable back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quotaops-descriptor-"));
  const previous = process.env.QUOTAOPS_DESCRIPTOR_PATH;
  process.env.QUOTAOPS_DESCRIPTOR_PATH = join(directory, "dashboard-runtime.json");

  try {
    const descriptor = descriptorFor(45_678, createInstanceId());
    await writeDescriptor(descriptor);

    assert.deepEqual(await readDescriptor(), descriptor);
  } finally {
    if (previous === undefined) delete process.env.QUOTAOPS_DESCRIPTOR_PATH;
    else process.env.QUOTAOPS_DESCRIPTOR_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
