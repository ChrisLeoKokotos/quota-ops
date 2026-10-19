// Builds the dashboard as static assets for the desktop shell.
//
// The API routes are deliberately excluded rather than made static: in the
// desktop build they have no reason to exist. The renderer reaches the
// collector through the Electron IPC bridge, so there is no HTTP endpoint for
// a snapshot and nothing listening to attack. Next.js refuses to export a
// route marked `force-dynamic`, which is why they are moved aside rather than
// configured away.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const apiDir = join(repo, "app", "api");
const parked = join(repo, "app", "_api_excluded_from_static_build");

async function withApiRoutesParked(run) {
  const hadApi = existsSync(apiDir);
  if (hadApi) await rename(apiDir, parked);
  try {
    return run();
  } finally {
    // Always restore, including on failure: leaving the tree mutated would
    // silently break the web build and every test that imports those routes.
    if (hadApi && existsSync(parked)) await rename(parked, apiDir);
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
await rm(target, { recursive: true, force: true });
await rename(out, target);
await rm(join(repo, "out"), { recursive: true, force: true });
process.stdout.write(`[static] exported to ${target}\n`);
