// Create an *unsigned local testing installer*, not a distributable release.
// The owner must run Windows E2E and get independent security/code-sign review.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") {
  throw new Error("Windows NSIS installer must be produced on Windows.");
}
for (const relative of [
  "collector/service.ts",
  "desktop/electron-ipc/main.js",
  "desktop/electron-ipc/icon.ico",
  "node_modules/playwright-core/package.json",
]) {
  if (!existsSync(join(root, relative))) {
    throw new Error(`Required installer input missing: ${relative}`);
  }
}

const staticBuild = spawnSync(
  process.execPath, [join(root, "desktop", "build-static.mjs")],
  { cwd: root, stdio: "inherit" },
);
if (staticBuild.error) throw staticBuild.error;
if (staticBuild.status !== 0) {
  throw new Error("Static export failed; installer was not created.");
}
for (const relative of [
  "desktop/static-dist/index.html",
  "desktop/static-dist/csp-script-hashes.json",
]) {
  if (!existsSync(join(root, relative))) {
    throw new Error(`Cannot package missing static resource: ${relative}`);
  }
}

// Exact builder version, isolated via npm exec. No local lockfile updates and
// no auto-publishing. The installer is NOT signed or automatically updated.
// All arguments here are fixed literals, never supplied by the renderer.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const args = [
  "exec", "--yes", "--package=electron-builder@26.4.0", "--",
  "electron-builder", "--win", "nsis", "--x64",
  "--config", "desktop/electron-builder.json", "--publish", "never",
];
const built = spawnSync(npm, args, {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (built.error) throw built.error;
if (built.status !== 0) {
  throw new Error("Windows installer build failed.");
}
process.stdout.write(
  "Unsigned test installer created under release/windows. " +
  "Do not distribute until E2E, security sign-off, and code-signing decision.\n",
);
