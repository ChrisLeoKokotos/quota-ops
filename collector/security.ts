import { execFile } from "node:child_process";
import {
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";

import {
  getCollectorTokenPath,
  getProfileRoot,
  getQuotaOpsHome,
} from "./paths.ts";

const execFileAsync = promisify(execFile);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isPathWithin(
  rootPath: string,
  candidatePath: string,
): boolean {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const rel = relative(root, candidate);

  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link for security-sensitive path: ${path}`);
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") return;
    throw error;
  }
}

function windowsIdentity(): string {
  const username = process.env.USERNAME?.trim() || userInfo().username;
  const domain = process.env.USERDOMAIN?.trim();

  return domain ? `${domain}\\${username}` : username;
}

async function hardenWindowsDirectory(path: string): Promise<void> {
  const identity = windowsIdentity();

  await execFileAsync("icacls", [
    path,
    "/inheritance:r",
    "/grant:r",
    `${identity}:(OI)(CI)F`,
    "/grant:r",
    "*S-1-5-18:(OI)(CI)F",
    "/grant:r",
    "*S-1-5-32-544:(OI)(CI)F",
  ]);
}

let hardeningPromise: Promise<void> | null = null;

async function hardenCollectorHome(): Promise<void> {
  const home = getQuotaOpsHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  await rejectSymlink(home);

  if (process.platform === "win32") {
    await hardenWindowsDirectory(home);
  } else {
    await chmod(home, 0o700);
  }

  const profileRoot = getProfileRoot();
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await rejectSymlink(profileRoot);

  if (process.platform !== "win32") {
    await chmod(profileRoot, 0o700);
  }
}

export function ensureCollectorHomeSecurity(): Promise<void> {
  hardeningPromise ??= hardenCollectorHome();
  return hardeningPromise;
}

export async function assertSafeProfileDirectory(
  profileDir: string,
): Promise<void> {
  if (!isPathWithin(getProfileRoot(), profileDir)) {
    throw new Error("Collector profile directory is outside the protected QuotaOps profile root.");
  }

  await rejectSymlink(profileDir);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });

  const [realRoot, realProfile] = await Promise.all([
    realpath(getProfileRoot()),
    realpath(profileDir),
  ]);
  if (!isPathWithin(realRoot, realProfile)) {
    throw new Error("Collector profile resolves outside the protected QuotaOps profile root.");
  }

  if (process.platform !== "win32") {
    await chmod(profileDir, 0o700);
  }
}

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isValidCollectorToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function collectorTokenMatches(
  expected: string,
  supplied: string,
): boolean {
  if (!isValidCollectorToken(expected) || !isValidCollectorToken(supplied)) {
    return false;
  }

  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");

  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

export async function getOrCreateCollectorToken(): Promise<string> {
  await ensureCollectorHomeSecurity();

  const path = getCollectorTokenPath();
  await rejectSymlink(path);

  try {
    const token = (await readFile(path, "utf8")).trim();
    if (!isValidCollectorToken(token)) {
      throw new Error("Collector token file is invalid. Rotate the token before starting the collector.");
    }
    return token;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code !== "ENOENT") throw error;

    const token = generateToken();

    try {
      await writeFile(path, token + "\n", {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });

      if (process.platform !== "win32") {
        await chmod(path, 0o600);
      }

      return token;
    } catch (createError) {
      const createNodeError = createError as NodeJS.ErrnoException;
      if (createNodeError.code !== "EEXIST") throw createError;

      const existing = (await readFile(path, "utf8")).trim();
      if (!isValidCollectorToken(existing)) {
        throw new Error("Collector token file became invalid during startup.");
      }
      return existing;
    }
  }
}

export async function rotateCollectorToken(): Promise<string> {
  await ensureCollectorHomeSecurity();

  const path = getCollectorTokenPath();
  await rejectSymlink(path);

  const token = generateToken();
  await writeFile(path, token + "\n", {
    encoding: "utf8",
    flag: "w",
    mode: 0o600,
  });

  if (process.platform !== "win32") {
    await chmod(path, 0o600);
  }

  return token;
}
