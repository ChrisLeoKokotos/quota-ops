export type LocalRuntimeId = "ollama";
export type LocalRuntimeState = "online" | "offline" | "partial";

export interface LocalModelSnapshot {
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

export interface LocalRuntimeSnapshot {
  runtime: LocalRuntimeId;
  label: string;
  state: LocalRuntimeState;
  version: string | null;
  checkedAt: string;
  models: LocalModelSnapshot[];
  message: string | null;
}

export function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(value) / Math.log(1024)),
  );
  const scaled = value / 1024 ** index;

  return `${scaled.toFixed(scaled >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}
