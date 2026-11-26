import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { publishStaticBundle } from "../desktop/static-publication.mjs";

async function fixture(run: (paths: { root: string; source: string; target: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "quotaops-publish-"));
  const source = join(root, ".next-static");
  const target = join(root, "static-dist");
  try {
    await mkdir(join(source, "_next"), { recursive: true });
    await mkdir(target);
    await writeFile(join(source, "index.html"), "new export");
    await writeFile(join(source, "_next", "chunk.js"), "new chunk");
    await writeFile(join(target, "index.html"), "previous good export");
    await writeFile(join(target, "old.txt"), "keep if anything fails");
    await run({ root, source, target });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("publishing preserves complete exports and stages the CSP manifest before promotion", async () => {
  await fixture(async ({ root, source, target }) => {
    await publishStaticBundle({
      source, target,
      prepare: async (staged) => {
        assert.equal(await readFile(join(staged, "index.html"), "utf8"), "new export");
        await writeFile(join(staged, "csp-script-hashes.json"), '{"version":1,"scriptHashes":[]}');
      },
    });
    assert.equal(await readFile(join(target, "index.html"), "utf8"), "new export");
    assert.equal(await readFile(join(target, "_next", "chunk.js"), "utf8"), "new chunk");
    assert.match(await readFile(join(target, "csp-script-hashes.json"), "utf8"), /scriptHashes/);
    // Keeping Next output intact prevents reliance on renaming a potentially
    // still-open compiler cache directory on Windows.
    assert.equal(await readFile(join(source, "index.html"), "utf8"), "new export");
    assert.ok(!(await readdir(target)).includes("old.txt"));
    assert.ok(!(await readdir(root)).some((file) => file.includes("static-stage-")));
  });
});

test("when Windows locks the live bundle, do not delete or modify it", async () => {
  await fixture(async ({ root, source, target }) => {
    await assert.rejects(
      publishStaticBundle({
        source, target,
        prepare: async () => {},
        renamePath: async (from, to) => {
          if (from === target) {
            const error = new Error("simulated Windows sharing violation");
            Object.assign(error, { code: "EPERM" });
            throw error;
          }
          await rename(from, to);
        },
      }),
      /simulated Windows sharing violation/,
    );
    assert.equal(await readFile(join(target, "index.html"), "utf8"), "previous good export");
    assert.equal(await readFile(join(target, "old.txt"), "utf8"), "keep if anything fails");
    assert.ok(!(await readdir(root)).some((file) => file.includes("static-stage-")));
  });
});

test("when promotion fails after moving the previous bundle, roll it back", async () => {
  await fixture(async ({ root, source, target }) => {
    await assert.rejects(
      publishStaticBundle({
        source, target,
        prepare: async (staged) => {
          await writeFile(join(staged, "csp-script-hashes.json"), "{}");
        },
        renamePath: async (from, to) => {
          if (basename(from).startsWith(".quotaops-static-stage-") && !from.endsWith(".previous") && to === target) {
            const error = new Error("simulated EPERM promoting staging directory");
            Object.assign(error, { code: "EPERM" });
            throw error;
          }
          await rename(from, to);
        },
      }),
      /simulated EPERM promoting staging directory/,
    );
    assert.equal(await readFile(join(target, "index.html"), "utf8"), "previous good export");
    assert.equal(await readFile(join(target, "old.txt"), "utf8"), "keep if anything fails");
    assert.ok(!(await readdir(root)).some((file) => file.includes("static-stage-")));
  });
});

test("a failed CSP preparation never publishes an incomplete bundle", async () => {
  await fixture(async ({ root, source, target }) => {
    await assert.rejects(
      publishStaticBundle({
        source, target,
        prepare: async () => { throw new Error("manifest generator failed"); },
      }),
      /manifest generator failed/,
    );
    assert.equal(await readFile(join(target, "index.html"), "utf8"), "previous good export");
    assert.ok(!(await readdir(root)).some((file) => file.includes("static-stage-")));
  });
});

test("no export file is published when Next output lacks index.html", async () => {
  await fixture(async ({ source, target }) => {
    await rm(join(source, "index.html"));
    await assert.rejects(
      publishStaticBundle({ source, target, prepare: async () => {} }),
      /missing index.html/,
    );
    assert.equal(await readFile(join(target, "index.html"), "utf8"), "previous good export");
  });
});
