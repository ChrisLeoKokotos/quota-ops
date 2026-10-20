// Create an *unsigned local testing installer*, not a distributable release.
// The owner must run Windows E2E and get independent security/code-sign review.
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateBrandingAssets } from "./branding/generate-icons.mjs";

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

// Regenerate the branded icons from the approved logo on every build, so a
// package can never ship a stale asset or quietly fall back to the earlier
// synthetic placeholder. The source logo is read, never written.
const branding = await generateBrandingAssets();
for (const asset of branding.assets) {
  process.stdout.write(
    `[installer] ${asset.name.padEnd(22)} ${String(asset.bytes).padStart(7)} bytes  ` +
      `sha256:${asset.sha256.slice(0, 12)}\n`,
  );
}

const appIcon = branding.assets.find((asset) => asset.name === "quotaops-icon.ico");
if (!appIcon || appIcon.bytes < 4096) {
  throw new Error("Branded application icon is missing or suspiciously small.");
}

// electron-builder resolves `files` against the app directory, so the icons
// are staged beside main.js before packaging. desktop/branding/ stays the
// committed source of truth.
for (const name of ["quotaops-icon.ico", "quotaops-tray.ico"]) {
  await copyFile(
    join(root, "desktop", "branding", name),
    join(root, "desktop", "electron-ipc", name),
  );
}
process.stdout.write("[installer] branded icons staged into the app directory\n");

// The *test-only* config intentionally skips executable resource editing and
// signing to avoid winCodeSign's Mac dylib symlinks on standard Windows accounts.
// The ordinary release manifest stays untouched and requires real signing.
// Side effect: test QuotaOps.exe has Electron's default icon/metadata.
const testConfigPath = join(root, "desktop", "electron-builder.unsigned-test.json");
const testConfig = JSON.parse(await readFile(testConfigPath, "utf8"));
if (testConfig.extends !== "desktop/electron-builder.json" ||
    testConfig.win?.signAndEditExecutable !== false ||
    Object.keys(testConfig.win).length !== 1 ||
    testConfig.afterExtract !== "desktop/branding/after-extract-pe.cjs" ||
    testConfig.afterPack !== "desktop/branding/after-pack-pe.cjs" ||
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
// State the actual experiment mode, never claim an unverified icon is ready
// for distribution. A local Windows packaged-boot test remains compulsory.
if (process.env.QUOTAOPS_BRANDED_PE_PROBE === "1") {
  process.stdout.write(
    "EXPERIMENTAL PE BRANDING: pre-integrity icon and post-pack resource\n" +
      "checks were enabled. This is still UNSIGNED and NOT release approved.\n" +
      "Run isolated packaged startup smoke again; verify icon visually and\n" +
      "obtain independent ASAR-integrity/security review before release.\n",
  );
} else {
  process.stdout.write(
    "Branding: installer, uninstaller, window and tray carry the QuotaOps logo.\n" +
      "QuotaOps.exe does NOT: `signAndEditExecutable: false` skips resource editing,\n" +
      "and enabling it fails extracting winCodeSign's macOS dylib symlinks without\n" +
      "administrator rights or Developer Mode. Desktop and Start Menu shortcuts\n" +
      "inherit the executable's icon, so they are unbranded too.\n",
  );
}
