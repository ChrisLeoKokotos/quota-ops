// Build a SIGNED Windows release candidate with the release configuration
// (desktop/electron-builder.json: executable resources edited, so the EXE
// carries the QuotaOps icon and ASAR integrity, and everything is signed).
//
// Signing material comes only from the environment of a protected job:
//   CSC_LINK / CSC_KEY_PASSWORD (PFX), as electron-builder reads them.
// Nothing is published (--publish never). Success is reported only after
// Windows confirms an Authenticode signature on QuotaOps.exe and on the
// installer, and SHA256SUMS.txt has been written.
//
// QUOTAOPS_SIGNING_DRY_RUN=1 + QUOTAOPS_EXPECTED_SIGNER_THUMBPRINT: CI proof
// of the mechanics with a throwaway self-signed certificate. Windows then
// reports the chain as untrusted; the output is NOT distributable.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateBrandingAssets } from "./branding/generate-icons.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") throw new Error("Windows only.");
const dryRun = process.env.QUOTAOPS_SIGNING_DRY_RUN === "1";
const expectedThumbprint = (process.env.QUOTAOPS_EXPECTED_SIGNER_THUMBPRINT ?? "").toUpperCase();
if (!process.env.CSC_LINK || !process.env.CSC_KEY_PASSWORD) {
  throw new Error("Refusing to build a release candidate without signing material (CSC_LINK, CSC_KEY_PASSWORD).");
}
if (dryRun && !/^[0-9A-F]{40}$/.test(expectedThumbprint)) {
  throw new Error("A signing dry run must name the throwaway certificate thumbprint.");
}
const config = JSON.parse(await readFile(join(root, "desktop", "electron-builder.json"), "utf8"));
if (config.publish !== null || config.win?.signAndEditExecutable === false) {
  throw new Error("Release config must not publish and must edit/sign the executable.");
}
const { version } = JSON.parse(await readFile(join(root, "desktop", "electron-ipc", "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Unexpected app version.");

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} failed (${result.status}).`);
};
run(process.execPath, [join(root, "desktop", "build-static.mjs")]);
await generateBrandingAssets();
for (const name of ["quotaops-icon.ico", "quotaops-tray.ico"]) {
  await copyFile(join(root, "desktop", "branding", name), join(root, "desktop", "electron-ipc", name));
}
const started = Date.now();
run("npm.cmd", [
  "exec", "--yes", "--package=electron-builder@26.13.1", "--",
  "electron-builder", "--win", "nsis", "--x64",
  "--config", "desktop/electron-builder.json", "--publish", "never",
], { shell: true });

const installer = join(root, "release", "windows", `QuotaOps-Setup-${version}-x64.exe`);
const exe = join(root, "release", "windows", "win-unpacked", "QuotaOps.exe");
for (const file of [installer, exe]) {
  if (!existsSync(file)) throw new Error(`Missing build output: ${file}`);
}

function signature(file) {
  const script = `$s=Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}';` +
    "\"$($s.Status)|$($s.SignerCertificate.Thumbprint)|$($s.TimeStamperCertificate -ne $null)\"";
  // Windows PowerShell started from PowerShell 7 (as on CI runners) inherits
  // PSModulePath and then fails to load its own Security module.
  const env = { ...process.env };
  delete env.PSModulePath;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", env });
  const [status, thumbprint, timestamped] = result.stdout.trim().split("|");
  return {
    status,
    thumbprint: (thumbprint ?? "").toUpperCase(),
    timestamped: timestamped === "True",
    diagnostics: `${result.stdout.trim()} ${result.stderr.trim()}`.slice(0, 400),
  };
}
for (const file of [exe, installer]) {
  const sig = signature(file);
  if (!sig.thumbprint) throw new Error(`${basename(file)} is not signed (verifier output: ${sig.diagnostics}).`);
  if (expectedThumbprint && sig.thumbprint !== expectedThumbprint) {
    throw new Error(`${basename(file)} is signed by an unexpected certificate.`);
  }
  if (!dryRun && sig.status !== "Valid") throw new Error(`${basename(file)} signature status: ${sig.status}`);
  if (dryRun && !["Valid", "UnknownError", "NotTrusted"].includes(sig.status)) {
    throw new Error(`${basename(file)} dry-run signature status: ${sig.status}`);
  }
  process.stdout.write(`${basename(file)}: signature ${sig.status}, signer ${sig.thumbprint.slice(0, 12)}..., timestamped=${sig.timestamped}\n`);
}

const hash = createHash("sha256");
for await (const chunk of createReadStream(installer)) hash.update(chunk);
const sums = `${hash.digest("hex")}  ${basename(installer)}\n`;
await writeFile(join(root, "release", "windows", "SHA256SUMS.txt"), sums);
process.stdout.write(`SHA256SUMS.txt: ${sums}`);
process.stdout.write(`Build took ${Math.round((Date.now() - started) / 1000)} s.\n`);
process.stdout.write(dryRun
  ? "DRY RUN: signed with a throwaway, untrusted certificate. NOT distributable.\n"
  : "Signed release candidate. Not published. Verify on a clean machine before any release.\n");
