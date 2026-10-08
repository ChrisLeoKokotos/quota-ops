import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

test("standard dashboard commands stay loopback-bound", () => {
  for (const script of ["dev", "start"]) {
    const command = pkg.scripts[script] ?? "";
    assert.equal(command.includes("--hostname 127.0.0.1"), true);
    assert.equal(command.includes("--hostname 0.0.0.0"), false);
  }
});
