"use strict";

// OPT-IN, UNSIGNED TEST BUILD ONLY. Never used by the release manifest.
// electron-builder v26 invokes afterExtract before it writes Electron's ASAR
// integrity PE resource. Editing afterward may invalidate the security check.
// This uses resedit already bundled with the exact pinned electron-builder,
// not an extra downloaded executable or a new project runtime dependency.
const { createRequire } = require("node:module");
const { createHash } = require("node:crypto");
const { readFile, writeFile, rename, unlink } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");

// On by default for the unsigned test build (owner requirement: branded
// QuotaOps.exe). QUOTAOPS_BRANDED_PE_PROBE=0 turns it off. The release
// configuration does not use these hooks: it edits and signs the executable
// through electron-builder itself (see desktop/build-signed-candidate.mjs).
const ENABLED = process.env.QUOTAOPS_BRANDED_PE_PROBE !== "0";
const ICON_PATH = resolve(__dirname, "quotaops-icon.ico");

function reseditFromBuilder() {
  const cliPath = process.argv[1];
  if (typeof cliPath !== "string" || !cliPath.includes("electron-builder")) {
    throw new Error("PE icon probe requires the pinned electron-builder CLI.");
  }
  try {
    // Load the exact resedit version from app-builder-lib (the installed,
    // pinned builder dependency), including when npm has nested packages.
    // Nothing is downloaded or installed by this hook.
    const fromBuilderCLI = createRequire(resolve(cliPath));
    const builderLibrary = fromBuilderCLI.resolve("app-builder-lib/package.json");
    return createRequire(builderLibrary)("resedit");
  } catch {
    throw new Error("Pinned electron-builder did not expose resedit; aborting PE icon probe.");
  }
}

async function readPE(path, resedit) {
  const peBytes = await readFile(path);
  const executable = resedit.NtExecutable.from(peBytes);
  const resources = resedit.NtExecutableResource.from(executable);
  return { executable, resources };
}

async function afterExtract(context) {
  if (!ENABLED) return;
  if (process.platform !== "win32" || context.electronPlatformName !== "win32") {
    throw new Error("PE icon probe is Windows-only.");
  }
  if (!existsSync(ICON_PATH)) throw new Error("Branded ICO source is missing.");
  const resedit = reseditFromBuilder();
  const { Data, Resource } = resedit;
  // At afterExtract, electron.exe is still the upstream shell. In case
  // electron-builder changes its ordering, fail closed instead of guessing.
  const target = join(context.appOutDir, "electron.exe");
  if (!existsSync(target)) {
    throw new Error("Expected extracted electron.exe before rename; packaging order changed.");
  }

  const { executable, resources } = await readPE(target, resedit);
  if (resources.entries.some((entry) => String(entry.type).toLowerCase() === "integrity")) {
    throw new Error("ASAR integrity already embedded: refusing post-integrity PE edit.");
  }
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  if (groups.length !== 1) {
    throw new Error("Unexpected stock Electron icon groups; refusing to guess resource IDs.");
  }
  const iconData = Data.IconFile.from(await readFile(ICON_PATH));
  Resource.IconGroupEntry.replaceIconsForResource(
    resources.entries,
    groups[0].id,
    groups[0].lang,
    iconData.icons.map((item) => item.data),
  );

  // Version strings shown by Explorer, Task Manager and "Open with": the
  // stock binary says "Electron / GitHub, Inc.". Same pre-integrity edit.
  const appInfo = context.packager && context.packager.appInfo;
  const version = String((appInfo && appInfo.version) || "");
  const parts = version.split(".").map((value) => Number.parseInt(value, 10));
  if (parts.length !== 3 || parts.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("Unexpected app version for PE metadata.");
  }
  const versions = Resource.VersionInfo.fromEntries(resources.entries);
  if (versions.length !== 1) throw new Error("Unexpected stock Electron version resources.");
  const info = versions[0];
  const languages = info.getAllLanguagesForStringValues();
  if (languages.length === 0) throw new Error("Stock Electron version resource has no string table.");
  const productName = String((appInfo && appInfo.productName) || "QuotaOps");
  const companyName = String((appInfo && appInfo.companyName) || "So Homely");
  for (const language of languages) {
    info.setStringValues(language, {
      ProductName: productName,
      FileDescription: productName,
      CompanyName: companyName,
      InternalName: productName,
      OriginalFilename: `${productName}.exe`,
      LegalCopyright: `Copyright (C) ${new Date().getFullYear()} ${companyName}`,
      FileVersion: version,
      ProductVersion: version,
    });
  }
  info.setFileVersion(parts[0], parts[1], parts[2], 0, languages[0].lang);
  info.setProductVersion(parts[0], parts[1], parts[2], 0, languages[0].lang);
  info.outputToResourceEntries(resources.entries);

  resources.outputResource(executable);
  const newBinary = Buffer.from(executable.generate());
  const stage = join(context.appOutDir, `.quotaops-icon-${process.pid}.tmp`);
  try {
    await writeFile(stage, newBinary, { flag: "wx" });
    // Only the Electron binary in the generated staging output is modified.
    // Neither the source installation nor existing signed binaries are edited.
    await rename(stage, target);
  } finally {
    await unlink(stage).catch(() => undefined);
  }
  const digest = createHash("sha256").update(newBinary).digest("hex").slice(0, 12);
  process.stdout.write(`[branding-probe] QuotaOps icon and version strings applied before ASAR integrity (sha256:${digest})\n`);
}

async function afterPack(context) {
  if (!ENABLED) return;
  const resedit = reseditFromBuilder();
  const target = join(context.appOutDir, "QuotaOps.exe");
  if (!existsSync(target)) throw new Error("Packaged QuotaOps.exe missing for PE icon check.");
  const { resources } = await readPE(target, resedit);

  // Confirm the actual PNG frame was embedded into the PE, not just a
  // colourful stock Electron icon or the installer banner.
  const ico = await readFile(ICON_PATH);
  const count = ico.readUInt16LE(4);
  let largeIcon = null;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = 6 + index * 16;
    if (ico[entryOffset] === 0 && ico[entryOffset + 1] === 0) {
      const size = ico.readUInt32LE(entryOffset + 8);
      const offset = ico.readUInt32LE(entryOffset + 12);
      largeIcon = ico.subarray(offset, offset + size);
      break;
    }
  }
  if (!largeIcon || !resources.entries.some((entry) =>
    Number(entry.type) === 3 && Buffer.from(entry.bin).equals(largeIcon))) {
    throw new Error("The actual QuotaOps icon is absent from packaged PE resources.");
  }
  const versionInfo = resedit.Resource.VersionInfo.fromEntries(resources.entries)[0];
  const strings = versionInfo && versionInfo.getAllLanguagesForStringValues()
    .map((language) => versionInfo.getStringValues(language))[0];
  if (!strings || strings.FileDescription !== "QuotaOps" || strings.ProductName !== "QuotaOps") {
    throw new Error("Packaged QuotaOps.exe does not carry QuotaOps version strings.");
  }
  const asarIntegrity = resources.entries.find((entry) =>
    String(entry.type).toLowerCase() === "integrity" &&
    String(entry.id).toLowerCase() === "electronasar");
  if (!asarIntegrity) {
    throw new Error("No ElectronAsar INTEGRITY resource remains in branded PE.");
  }
  let entries;
  try {
    entries = JSON.parse(Buffer.from(asarIntegrity.bin).toString("utf8"));
  } catch {
    throw new Error("Embedded ElectronAsar integrity resource is not valid JSON.");
  }
  if (!Array.isArray(entries) || !entries.some((entry) =>
    typeof entry.value === "string" && /^[a-f0-9]{64}$/i.test(entry.value) &&
    entry.alg?.toLowerCase() === "sha256" &&
    String(entry.file).replaceAll("/", "\\").toLowerCase() === "resources\\app.asar")) {
    throw new Error("Packaged PE has an invalid ElectronAsar integrity manifest.");
  }
  process.stdout.write("[branding-probe] packaged QuotaOps.exe has approved 256px icon AND ElectronAsar integrity manifest\n");
}

module.exports = { afterExtract, afterPack };
