import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { collectOllamaRuntime } from "../collector/ollama.ts";

type FetchArgs = Parameters<typeof fetch>;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Serves each Ollama endpoint from a routing table. A route may be a payload,
 * a Response, or an Error to reject with, so a test can fail one endpoint
 * while the others succeed.
 */
function stubOllama(routes: Record<string, unknown>): void {
  globalThis.fetch = (async (...args: FetchArgs) => {
    const url = String(args[0]);
    const path = new URL(url).pathname;

    if (!(path in routes)) throw new Error(`unexpected request to ${path}`);
    const route = routes[path];

    if (route instanceof Error) throw route;
    if (route instanceof Response) return route;
    return jsonResponse(route);
  }) as typeof fetch;
}

test("an unreachable Ollama runtime is offline with no fabricated counts", async () => {
  stubOllama({
    "/api/version": new Error("ECONNREFUSED"),
    "/api/tags": new Error("ECONNREFUSED"),
    "/api/ps": new Error("ECONNREFUSED"),
  });

  const snapshot = await collectOllamaRuntime();

  assert.equal(snapshot.state, "offline");
  assert.equal(snapshot.version, null);
  assert.deepEqual(snapshot.models, []);
  assert.equal(snapshot.installedModelCount, null);
  assert.equal(snapshot.loadedModelCount, null);
  assert.equal(Number.isNaN(Date.parse(snapshot.checkedAt)), false);
});

test("a running Ollama with no models reports zero, not unknown", async () => {
  stubOllama({
    "/api/version": { version: "0.6.2" },
    "/api/tags": { models: [] },
    "/api/ps": { models: [] },
  });

  const snapshot = await collectOllamaRuntime();

  // Both endpoints answered, so zero is a measurement rather than a guess.
  assert.equal(snapshot.state, "online");
  assert.equal(snapshot.version, "0.6.2");
  assert.equal(snapshot.installedModelCount, 0);
  assert.equal(snapshot.loadedModelCount, 0);
  assert.equal(snapshot.message, null);
});

test("a failed /api/ps leaves loaded state unknown instead of zero", async () => {
  stubOllama({
    "/api/version": { version: "0.6.2" },
    "/api/tags": {
      models: [
        { name: "llama3:8b", size: 4_700_000_000 },
        { name: "qwen3:14b", size: 9_300_000_000 },
      ],
    },
    "/api/ps": new Error("socket hang up"),
  });

  const snapshot = await collectOllamaRuntime();

  assert.equal(snapshot.state, "partial");
  assert.equal(snapshot.installedModelCount, 2);
  assert.equal(snapshot.loadedModelCount, null);
  // Nothing may claim these models are unloaded; the runtime never answered.
  for (const model of snapshot.models) {
    assert.equal(model.loaded, null);
    assert.equal(model.vramBytes, null);
  }
});

test("a failed /api/tags leaves the installed count unknown", async () => {
  stubOllama({
    "/api/version": { version: "0.6.2" },
    "/api/tags": new Error("socket hang up"),
    "/api/ps": { models: [{ name: "llama3:8b", size_vram: 5_000_000_000 }] },
  });

  const snapshot = await collectOllamaRuntime();

  assert.equal(snapshot.state, "partial");
  assert.equal(snapshot.installedModelCount, null);
  assert.equal(snapshot.loadedModelCount, 1);
  assert.match(String(snapshot.message), /could not be read/);
});

test("an HTTP error from an endpoint is treated as unknown, not empty", async () => {
  stubOllama({
    "/api/version": { version: "0.6.2" },
    "/api/tags": { models: [{ name: "llama3:8b" }] },
    "/api/ps": new Response("upstream failure", { status: 500 }),
  });

  const snapshot = await collectOllamaRuntime();

  assert.equal(snapshot.state, "partial");
  assert.equal(snapshot.loadedModelCount, null);
});

test("a malformed endpoint body does not become an empty model list", async () => {
  stubOllama({
    "/api/version": { version: "0.6.2" },
    "/api/tags": { models: [{ name: "llama3:8b" }] },
    "/api/ps": new Response("{not json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  });

  const snapshot = await collectOllamaRuntime();

  assert.equal(snapshot.state, "partial");
  assert.equal(snapshot.loadedModelCount, null);
});

test("an unexpected payload shape leaves counts unknown", async () => {
  stubOllama({
    "/api/version": { version: "0.6.2" },
    "/api/tags": { models: "all-of-them" },
    "/api/ps": { unexpected: true },
  });

  const snapshot = await collectOllamaRuntime();

  assert.equal(snapshot.state, "partial");
  assert.equal(snapshot.installedModelCount, null);
  assert.equal(snapshot.loadedModelCount, null);
});

test("an oversized endpoint response is rejected rather than parsed", async () => {
  const oversized = JSON.stringify({
    models: [{ name: "x".repeat(3 * 1024 * 1024) }],
  });

  stubOllama({
    "/api/version": { version: "0.6.2" },
    "/api/tags": new Response(oversized, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
    "/api/ps": { models: [] },
  });

  const snapshot = await collectOllamaRuntime();

  assert.equal(snapshot.state, "partial");
  assert.equal(snapshot.installedModelCount, null);
  assert.equal(snapshot.loadedModelCount, 0);
});

test("a reachable runtime never invents a quota window or limit", async () => {
  stubOllama({
    "/api/version": { version: "0.6.2" },
    "/api/tags": { models: [{ name: "llama3:8b", size: 4_700_000_000 }] },
    "/api/ps": {
      models: [{ name: "llama3:8b", size_vram: 5_000_000_000 }],
    },
  });

  const snapshot = await collectOllamaRuntime();
  const serialized = JSON.stringify(snapshot);

  assert.equal(snapshot.state, "online");
  for (const invented of ["usedPercent", "resetAt", "windows", "plan", "quota"]) {
    assert.equal(
      serialized.includes(invented),
      false,
      `a local runtime must not carry ${invented}`,
    );
  }
});

test("only loopback Ollama endpoints are contacted", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (...args: FetchArgs) => {
    seen.push(String(args[0]));
    return jsonResponse({ models: [] });
  }) as typeof fetch;

  await collectOllamaRuntime();

  assert.equal(seen.length > 0, true);
  for (const url of seen) {
    assert.equal(
      new URL(url).origin,
      "http://127.0.0.1:11434",
      `unexpected destination ${url}`,
    );
  }
});
