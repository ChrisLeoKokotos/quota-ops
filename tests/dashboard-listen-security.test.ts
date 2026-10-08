import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

test("standard dashboard commands stay loopback-bound", () => {
  for (const script of ["dev", "start"]) {
    assert.match(pkg.scripts[script] ?? "", /(?:^|\\s)--hostname\\s+127\\.0\\.0\\.1(?:\\s|$)/);
    assert.doesNotMatch(pkg.scripts[script] ?? "", /0\\.0\\.0\\.0/);
  }
});
