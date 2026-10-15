import type {
  LocalModelSnapshot,
  LocalRuntimeSnapshot,
} from "../lib/local-runtime.ts";

const OLLAMA_ORIGIN = "http://127.0.0.1:11434";
const REQUEST_TIMEOUT_MS = 2_500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

interface OllamaModelRecord {
  name: string;
  family: string | null;
  parameterSize: string | null;
  quantization: string | null;
  sizeBytes: number | null;
  loaded: boolean;
  vramBytes: number | null;
  contextLength: number | null;
  expiresAt: string | null;
}

function modelRecord(value: unknown, loaded: boolean): OllamaModelRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = textOrNull(record.name ?? record.model);
  if (!name) return null;

  const details =
    record.details && typeof record.details === "object"
      ? (record.details as Record<string, unknown>)
      : {};

  return {
    name,
    family: textOrNull(details.family),
    parameterSize: textOrNull(details.parameter_size),
    quantization: textOrNull(details.quantization_level),
    sizeBytes: finiteNonNegative(record.size),
    loaded,
    vramBytes: loaded ? finiteNonNegative(record.size_vram) : null,
    contextLength: loaded ? finiteNonNegative(record.context_length) : null,
    expiresAt: loaded ? textOrNull(record.expires_at) : null,
  };
}

export function parseOllamaModels(
  installedPayload: unknown,
  runningPayload: unknown,
): LocalModelSnapshot[] {
  const installedRecord =
    installedPayload && typeof installedPayload === "object"
      ? (installedPayload as Record<string, unknown>)
      : {};
  const runningRecord =
    runningPayload && typeof runningPayload === "object"
      ? (runningPayload as Record<string, unknown>)
      : {};
  const runningKnown = Array.isArray(runningRecord.models);

  const installed = Array.isArray(installedRecord.models)
    ? installedRecord.models.map((item) => modelRecord(item, false)).filter(Boolean)
    : [];
  const running = Array.isArray(runningRecord.models)
    ? runningRecord.models.map((item) => modelRecord(item, true)).filter(Boolean)
    : [];

  const merged = new Map<string, LocalModelSnapshot>();

  for (const item of installed as OllamaModelRecord[]) {
    merged.set(item.name, { ...item, loaded: runningKnown ? false : null });
  }

  for (const item of running as OllamaModelRecord[]) {
    const previous = merged.get(item.name);
    merged.set(item.name, {
      name: item.name,
      family: item.family ?? previous?.family ?? null,
      parameterSize: item.parameterSize ?? previous?.parameterSize ?? null,
      quantization: item.quantization ?? previous?.quantization ?? null,
      sizeBytes: item.sizeBytes ?? previous?.sizeBytes ?? null,
      loaded: true,
      vramBytes: item.vramBytes,
      contextLength: item.contextLength,
      expiresAt: item.expiresAt,
    });
  }

  return [...merged.values()].sort((a, b) => {
    if (a.loaded !== b.loaded) {
      const rank = (loaded: boolean | null) => loaded === true ? 0 : loaded === null ? 1 : 2;
      return rank(a.loaded) - rank(b.loaded);
    }
    return a.name.localeCompare(b.name);
  });
}

async function fetchLocalJson(path: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${OLLAMA_ORIGIN}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama returned HTTP ${response.status} for ${path}`);
    }

    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_RESPONSE_BYTES
    ) {
      throw new Error("Ollama response exceeded the local size limit.");
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new Error("Ollama response exceeded the local size limit.");
    }

    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

function parsedModelCount(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const models = (payload as Record<string, unknown>).models;
  if (!Array.isArray(models)) return null;
  return models.filter((model) => modelRecord(model, false) !== null).length;
}

export function parseOllamaVersion(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  return textOrNull((payload as Record<string, unknown>).version);
}

export async function collectOllamaRuntime(): Promise<LocalRuntimeSnapshot> {
  const checkedAt = new Date().toISOString();

  try {
    const [versionResult, tagsResult, psResult] = await Promise.allSettled([
      fetchLocalJson("/api/version"),
      fetchLocalJson("/api/tags"),
      fetchLocalJson("/api/ps"),
    ]);

    if (
      versionResult.status === "rejected" &&
      tagsResult.status === "rejected" &&
      psResult.status === "rejected"
    ) {
      return {
        runtime: "ollama",
        label: "Ollama",
        state: "offline",
        version: null,
        checkedAt,
        models: [],
        installedModelCount: null,
        loadedModelCount: null,
        message: "Ollama was not reachable on 127.0.0.1:11434.",
      };
    }

    const version =
      versionResult.status === "fulfilled"
        ? parseOllamaVersion(versionResult.value)
        : null;
    const installed = tagsResult.status === "fulfilled" ? tagsResult.value : null;
    const running = psResult.status === "fulfilled" ? psResult.value : null;
    const installedModelCount = parsedModelCount(installed);
    const loadedModelCount = parsedModelCount(running);
    const models = parseOllamaModels(installed, running);

    const failed = [versionResult, tagsResult, psResult].filter(
      (result) => result.status === "rejected",
    ).length;

    return {
      runtime: "ollama",
      label: "Ollama",
      state: failed > 0 || installedModelCount === null || loadedModelCount === null
        ? "partial"
        : "online",
      version,
      checkedAt,
      models,
      installedModelCount,
      loadedModelCount,
      message:
        failed > 0 || installedModelCount === null || loadedModelCount === null
          ? "Ollama is reachable, but some runtime metadata could not be read."
          : null,
    };
  } catch {
    return {
      runtime: "ollama",
      label: "Ollama",
      state: "offline",
      version: null,
      checkedAt,
      models: [],
      installedModelCount: null,
      loadedModelCount: null,
      message: "Ollama was not reachable on 127.0.0.1:11434.",
    };
  }
}
