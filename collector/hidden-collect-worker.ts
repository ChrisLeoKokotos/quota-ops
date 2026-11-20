/**
 * Background collection worker for Windows, started by hidden-desktop.ts
 * through hidden-desktop-run.ps1 on a desktop the person never sees.
 *
 * It collects the requested accounts with an ordinary (headed) browser — the
 * same browser identity as the person's own manual verification, so a
 * verification the person completed is honoured — writes statuses and usage
 * to the result file and exits, which frees Playwright's memory.
 *
 * No challenge is clicked or solved; a challenged account is reported as
 * verification_required, exactly as in every other mode.
 */
import { rename, readFile, writeFile } from "node:fs/promises";

import { loadCollectorConfig } from "./config.ts";
import { collectProviderUsage } from "./provider.ts";
import type { CollectorAccountResult } from "./types.ts";

interface WorkerRequest {
  version: 1;
  nonce: string;
  accountIds: string[];
}

function isRequest(value: unknown): value is WorkerRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkerRequest>;
  return candidate.version === 1 &&
    typeof candidate.nonce === "string" && /^[a-f0-9]{32}$/.test(candidate.nonce) &&
    Array.isArray(candidate.accountIds) && candidate.accountIds.length <= 64 &&
    candidate.accountIds.every((id) => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id));
}

async function main(): Promise<void> {
  const [requestPath, resultPath] = process.argv.slice(2);
  if (!requestPath || !resultPath) throw new Error("usage: hidden-collect-worker <request> <result>");
  const request: unknown = JSON.parse(await readFile(requestPath, "utf8"));
  if (!isRequest(request)) throw new Error("invalid worker request");

  const config = await loadCollectorConfig();
  const results: CollectorAccountResult[] = [];
  for (const id of request.accountIds) {
    const account = config.accounts.find((candidate) =>
      candidate.id === id && candidate.enabled && candidate.provider !== "google");
    if (!account) continue;
    // Headed, on the hidden desktop: never on the person's screen.
    results.push(await collectProviderUsage(account, { visible: true }));
  }

  const temporary = `${resultPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, nonce: request.nonce, results }) + "\n", { mode: 0o600 });
  await rename(temporary, resultPath);
}

main().then(
  () => process.exit(0),
  () => process.exit(1),
);
