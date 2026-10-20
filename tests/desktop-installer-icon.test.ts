import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

test("generated Windows ICO embeds valid 16/32/48/256 PNG image frames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "quotaops-icon-"));
  try {
    const target = join(dir, "test.ico");
    const generator = fileURLToPath(
      new URL("../desktop/generate-installer-icon.mjs", import.meta.url),
    );
    // Use the exact Node runtime that runs the user's installer build. This
    // catches syntax/runtime regressions without an external image program.
    const generated = spawnSync(process.execPath, [
      "--input-type=module", "-e",
      "const m = await import(process.argv[1]); await m.generateInstallerIcon(process.argv[2]);",
      pathToFileURL(generator).href, target,
    ], { encoding: "utf8", timeout: 15_000 });
    assert.equal(generated.error, undefined);
    assert.equal(generated.status, 0, generated.stderr);

    const data = await readFile(target);
    assert.equal(data.readUInt16LE(0), 0);
    assert.equal(data.readUInt16LE(2), 1);
    assert.equal(data.readUInt16LE(4), 4);
    const sizes = [16, 32, 48, 256];
    for (let i = 0; i < sizes.length; i++) {
      const entry = 6 + 16 * i;
      const expected = sizes[i] ?? 0;
      assert.equal(data[entry], expected === 256 ? 0 : expected);
      assert.equal(data[entry + 1], expected === 256 ? 0 : expected);
      assert.equal(data.readUInt16LE(entry + 6), 32);
      const bytes = data.readUInt32LE(entry + 8);
      const offset = data.readUInt32LE(entry + 12);
      assert.ok(bytes >= 100, "PNG frame unexpectedly small");
      assert.ok(offset + bytes <= data.length, "image extends outside icon file");
      assert.deepEqual(
        data.subarray(offset, offset + 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      assert.equal(data.readUInt32BE(offset + 16), expected);
      assert.equal(data.readUInt32BE(offset + 20), expected);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
