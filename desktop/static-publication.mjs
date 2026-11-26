// Publish a generated Next.js desktop export without exposing users to an
// empty or half-written static-dist directory after a Windows rename failure.
// This module does not touch app/api, browser profiles, tokens, or credentials.
import { cp, lstat, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

async function pathInfo(path) {
  try { return await lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function checkStaticTree(root) {
  const stat = await pathInfo(root);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Static export directory is missing or invalid: ${root}`);
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const item = join(root, entry.name);
    if (entry.isDirectory()) await checkStaticTree(item);
    else if (!entry.isFile()) {
      throw new Error(`Static export contains an unsupported file type: ${item}`);
    }
  }
}

/**
 * Copy the exported source tree into a sibling staging folder, prepare it
 * (e.g. calculate CSP hashes), then switch the whole bundle over.
 * A failed Windows rename leaves the old deployment in place or restores it.
 * The source Next build directory is never renamed or removed.
 *
 * @param {object} options
 * @param {string} options.source  Next's .next-static output
 * @param {string} options.target  desktop/static-dist
 * @param {(directory: string) => Promise<void>} options.prepare
 * @param {(from: string, to: string) => Promise<void>} [options.renamePath]
 *   Injectable rename for permission/rollback regression tests.
 */
export async function publishStaticBundle({ source, target, prepare, renamePath = rename }) {
  if (typeof prepare !== "function") throw new TypeError("prepare is required");
  if (!(await pathInfo(join(source, "index.html")))?.isFile()) {
    throw new Error("Next.js static export is missing index.html");
  }
  await checkStaticTree(source);

  // mkdtemp is in the target's parent directory so the final rename is always
  // on the same volume, even when the repository lives on a secondary disk.
  const staging = await mkdtemp(join(dirname(target), ".quotaops-static-stage-"));
  const backup = `${staging}.previous`;
  let stagedMoved = false;
  let backupHeld = false;
  try {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await cp(join(source, entry.name), join(staging, entry.name), {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
      });
    }
    if (!(await pathInfo(join(staging, "index.html")))?.isFile()) {
      throw new Error("Copied static export is missing index.html");
    }
    await prepare(staging);
    await checkStaticTree(staging);

    const previous = await pathInfo(target);
    if (previous) {
      if (!previous.isDirectory() || previous.isSymbolicLink()) {
        throw new Error("Existing static-dist is not an ordinary directory");
      }
      await renamePath(target, backup);
      backupHeld = true;
    }

    try {
      await renamePath(staging, target);
      stagedMoved = true;
    } catch (promotionError) {
      if (backupHeld) {
        try {
          await renamePath(backup, target);
          backupHeld = false;
        } catch (restoreError) {
          throw new AggregateError(
            [promotionError, restoreError],
            `Failed to publish and restore static-dist; previous bundle is preserved at ${backup}`,
          );
        }
      }
      throw promotionError;
    }

    // After a successful swap, the bundle is live. Deleting an old backup is
    // only cleanup; a locked backup must not turn a good export into failure.
    if (backupHeld) {
      try {
        await rm(backup, { recursive: true, force: true });
        backupHeld = false;
      } catch (error) {
        process.stderr.write(
          `[static] deployed; could not delete old backup at ${backup}: ${error.code ?? error.message}\n`,
        );
      }
    }
  } catch (error) {
    if (!stagedMoved) {
      try { await rm(staging, { recursive: true, force: true }); }
      catch { /* Do not mask the original failure. */ }
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `[static] could not safely publish desktop/static-dist: ${reason}. ` +
      "Close any running development Electron window or antivirus scanner holding the export, then retry. " +
      "Do not delete app/api, profiles, or credentials.",
      { cause: error },
    );
  }
}
