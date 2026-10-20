// Create an *unsigned local testing installer*, not a distributable release.
// The owner must run Windows E2E and get independent security/code-sign review.
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateInstallerIcon } from "./generate-installer-icon.mjs";

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

// Electron Builder requires a 256x256 Windows icon. Generate a deterministic
// 16/32/48/256 ICO before packaging, leaving the existing tracked tray icon
// untouched and verifying the large frame at test time.
const installerIcon = join(root, "desktop", "installer-icon.ico");
const iconBytes = await generateInstallerIcon(installerIcon);
if (iconBytes < 1024) {
  throw new Error("Generated installer icon is suspiciously small.");
}
process.stdout.write(`[installer] generated multi-resolution ICO (${iconBytes} bytes)\n`);

// The *test-only* config intentionally skips executable resource editing and
// signing to avoid winCodeSign's Mac dylib symlinks on standard Windows accounts.
// The ordinary release manifest stays untouched and requires real signing.
// Side effect: test QuotaOps.exe has Electron's default icon/metadata.
const testConfigPath = join(root, "desktop", "electron-builder.unsigned-test.json");
const testConfig = JSON.parse(await readFile(testConfigPath, "utf8"));
if (testConfig.extends !== "desktop/electron-builder.json" ||
    testConfig.win?.signAndEditExecutable !== false ||
    Object.keys(testConfig.win).length !== 1 ||
    testConfig.publish !== null) {
  throw new Error("Refusing to build: unsigned test config has changed.");
}

// Exact builder version, isolated via npm exec. No local lockfile updates and
// no auto-publishing. The installer is NOT signed or automatically updated.
// All arguments here are fixed literals, never supplied by the renderer.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const args = [
  "exec", "--yes", "--package=electron-builder@26.4.0", "--",
  "electron-builder", "--win", "nsis", "--x64",
  "--config", "desktop/electron-builder.unsigned-test.json", "--publish", "never",
];
const buildStartedAt = Date.now();
const built = spawnSync(npm, args, {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (built.error) throw built.error;
if (built.status !== 0) {
  throw new Error("Windows installer build failed.");
}
const metadata = JSON.parse(
  await readFile(join(root, "desktop", "electron-ipc", "package.json"), "utf8"),
);
if (!/^\d+\.\d+\.\d+$/.test(metadata.version)) {
  throw new Error("Unexpected package version in installer metadata.");
}
const artifact = join(
  root, "release", "windows", `QuotaOps-Setup-${metadata.version}-x64.exe`,
);
if (!existsSync(artifact)) {
  throw new Error("Installer command returned success but the EXE is missing.");
}
const details = await stat(artifact);
if (details.size < 1_000_000 || details.mtimeMs < buildStartedAt - 3_000) {
  throw new Error("Installer artifact is too small or stale; cannot report success.");
}
const sha256 = createHash("sha256");
for await (const chunk of createReadStream(artifact)) sha256.update(chunk);
process.stdout.write(`Unsigned test installer: ${artifact}\n`);
process.stdout.write(`SHA-256: ${sha256.digest("hex")}\n`);
process.stdout.write(
  "Not approved for distribution: needs Windows E2E, human security sign-off, code signing.\n",
);
