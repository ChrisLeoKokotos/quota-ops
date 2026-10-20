// Builds the dashboard as static assets for the desktop shell.
//
// The API routes are deliberately excluded rather than made static: in the
// desktop build they have no reason to exist. The renderer reaches the
// collector through the Electron IPC bridge, so there is no HTTP endpoint for
// a snapshot and nothing listening to attack. Next.js refuses to export a
// route marked `force-dynamic`, which is why they are moved aside rather than
// configured away.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { publishStaticBundle } from "./static-publication.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(repo, "app", "api");
const parked = join(repo, "app", "_api_excluded_from_static_build");

/**
 * Moves the API routes aside for the duration of the export, and always puts
 * them back.
 *
 * The restore is gated on the parked directory existing, **not** on whether
 * this run parked it. An earlier version gated on the latter, which made the
 * mutation unrecoverable: if a run was interrupted after the rename — Ctrl-C
 * during `next build`, a crash, an antivirus hold — the next run saw no
 * `app/api`, parked nothing, succeeded, and restored nothing. `app/api` was
 * then gone for good, and because `_`-prefixed folders are App Router private
 * folders the web build kept succeeding while silently shipping without
 * `/api/collector/snapshot` and `/api/collector/capability`.
 *
 * It also refuses to start when both directories exist, rather than failing
 * mid-build: `rename` onto an existing directory is `EPERM` on Windows.
 */
async function withApiRoutesParked(run) {
  const apiExists = existsSync(apiDir);
  const parkedExists = existsSync(parked);

  if (apiExists && parkedExists) {
    throw new Error(
      `Both ${apiDir} and ${parked} exist. A previous build was interrupted. ` +
        "Inspect them, keep the correct one, remove the other, then re-run.",
    );
  }

  if (apiExists) await rename(apiDir, parked);

  // A signal would otherwise skip the `finally` and leave the tree mutated.
  const restoreSync = () => {
    try {
      if (existsSync(parked) && !existsSync(apiDir)) renameSync(parked, apiDir);
    } catch {
      process.stderr.write(`[static] could not restore ${apiDir}; restore it from git\n`);
    }
  };
  const onSignal = (signal) => {
    restoreSync();
    process.exit(signal === "SIGINT" ? 130 : 1);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("exit", restoreSync);

  try {
    return await run();
  } finally {
    if (existsSync(parked) && !existsSync(apiDir)) await rename(parked, apiDir);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("exit", restoreSync);
  }
}

// Invoke the Next CLI through Node directly: `npx` needs a shell on Windows,
// and spawning through one would reintroduce quoting problems on paths with
// spaces that this repository has already had to fix once.
const nextCli = join(repo, "node_modules", "next", "dist", "bin", "next");

const result = await withApiRoutesParked(() =>
  spawnSync(process.execPath, [nextCli, "build"], {
    cwd: repo,
    env: { ...process.env, QUOTAOPS_STATIC: "1", NODE_ENV: "production" },
    stdio: "inherit",
  }),
);

if (result.status !== 0) {
  process.stderr.write("[static] build failed\n");
  process.exit(result.status ?? 1);
}

// With a custom `distDir`, Next 16 writes the exported bundle into that
// directory rather than the default `out/`.
const out = join(repo, ".next-static");
if (!existsSync(join(out, "index.html"))) {
  process.stderr.write(`[static] expected an exported bundle at ${out}\n`);
  process.exit(1);
}

const target = join(repo, "desktop", "static-dist");
// Never delete the live bundle before preparing its replacement. Windows can
// refuse directory renames when an Electron window or AV scanner has an open
// handle, even after the Next build itself succeeds.
/**
 * Collects hashes of every inline script in the export.
 *
 * The desktop CSP would otherwise need `unsafe-inline` for scripts, which
 * removes most of CSP's value against injection. Next emits a small, fixed
 * set of inline bootstrap scripts whose contents are deterministic per build,
 * so they can be allowed by hash instead.
 */
async function collectInlineScriptHashes(directory) {
  const hashes = new Set();
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;

  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".html")) {
        const html = await readFile(full, "utf8");
        for (const match of html.matchAll(pattern)) {
          const body = match[1] ?? "";
          if (body.length === 0) continue;
          hashes.add(`sha256-${createHash("sha256").update(body, "utf8").digest("base64")}`);
        }
      }
    }
  };

  await walk(directory);
  return [...hashes].sort();
}

let scriptHashes = [];
await publishStaticBundle({
  source: out,
  target,
  prepare: async (staging) => {
    scriptHashes = await collectInlineScriptHashes(staging);
    // Generate CSP in the staged bundle so a failed build never publishes
    // HTML with a stale or missing hash manifest.
    await writeFile(
      join(staging, "csp-script-hashes.json"),
      JSON.stringify({ version: 1, scriptHashes }, null, 2) + "\n",
      "utf8",
    );
  },
});

// The legacy Next 'out' directory is not the source of truth. Its cleanup is
// best-effort; a Windows lock must never invalidate a successful publish.
await rm(join(repo, "out"), { recursive: true, force: true }).catch((error) => {
  process.stderr.write(`[static] unused out/ cleanup skipped: ${error.code ?? error.message}\n`);
});

process.stdout.write(`[static] exported to ${target}\n`);
process.stdout.write(`[static] ${scriptHashes.length} inline script hash(es) recorded\n`);
