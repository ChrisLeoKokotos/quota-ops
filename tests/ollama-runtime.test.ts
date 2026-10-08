import assert from "node:assert/strict";
import test from "node:test";

import {
  parseOllamaModels,
  parseOllamaVersion,
} from "../collector/ollama.ts";
import { formatBytes, totalLoadedVram } from "../lib/local-runtime.ts";

test("merges installed and running Ollama models without inventing quota", () => {
  const models = parseOllamaModels(
    {
      models: [
        {
          name: "qwen3:8b",
          size: 5_000_000_000,
          details: {
            family: "qwen3",
            parameter_size: "8.2B",
            quantization_level: "Q4_K_M",
          },
        },
        {
          name: "llama3.2:3b",
          size: 2_000_000_000,
          details: {
            family: "llama",
            parameter_size: "3.2B",
            quantization_level: "Q4_K_M",
          },
        },
      ],
    },
    {
      models: [
        {
          name: "qwen3:8b",
          size: 5_000_000_000,
          size_vram: 4_700_000_000,
          context_length: 32768,
          expires_at: "2026-10-08T03:00:00.000Z",
          details: {
            family: "qwen3",
            parameter_size: "8.2B",
            quantization_level: "Q4_K_M",
          },
        },
      ],
    },
  );

  assert.equal(models.length, 2);
  assert.equal(models[0]?.name, "qwen3:8b");
  assert.equal(models[0]?.loaded, true);
  assert.equal(models[0]?.vramBytes, 4_700_000_000);
  assert.equal(models[0]?.contextLength, 32768);
  assert.equal(models[1]?.name, "llama3.2:3b");
  assert.equal(models[1]?.loaded, false);
  assert.equal(models[1]?.vramBytes, null);
});

test("running-only Ollama models are still surfaced", () => {
  const models = parseOllamaModels(
    { models: [] },
    {
      models: [
        {
          model: "mistral:latest",
          size_vram: 3_000_000_000,
          details: {
            family: "mistral",
            parameter_size: "7.2B",
            quantization_level: "Q4_0",
          },
        },
      ],
    },
  );

  assert.equal(models.length, 1);
  assert.equal(models[0]?.name, "mistral:latest");
  assert.equal(models[0]?.loaded, true);
});

test("parses Ollama version defensively", () => {
  assert.equal(parseOllamaVersion({ version: "0.12.3" }), "0.12.3");
  assert.equal(parseOllamaVersion({ version: "" }), null);
  assert.equal(parseOllamaVersion(null), null);
});

test("formats runtime memory without fake precision", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024 ** 3), "1.0 GB");
  assert.equal(formatBytes(null), "—");
});


test("unavailable running model list never claims installed models are unloaded", () => {
  const models = parseOllamaModels(
    { models: [{ name: "qwen3:8b", details: { family: "qwen3" } }] },
    null,
  );
  assert.equal(models.length, 1);
  assert.equal(models[0]?.loaded, null);
  assert.equal(models[0]?.vramBytes, null);
});

test("VRAM cannot be totaled when some loaded model VRAM is unavailable", () => {
  const models = parseOllamaModels({ models: [] }, {
    models: [
      { name: "qwen3:8b", size_vram: 1_000 },
      { name: "mistral:7b" },
    ],
  });
  assert.equal(totalLoadedVram(models, 2), null);
  assert.equal(totalLoadedVram(models, null), null);
  assert.equal(totalLoadedVram(models, 3), null);
  assert.equal(totalLoadedVram([], 0), 0);
  assert.equal(totalLoadedVram(models.slice(0, 1), 1), 1_000);
});
