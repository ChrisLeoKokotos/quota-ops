import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("signed candidate build refuses to run or succeed without real signatures", async () => {
  const script = await readFile(new URL("../desktop/build-signed-candidate.mjs", import.meta.url), "utf8");
  assert.match(script, /if \(!process\.env\.CSC_LINK \|\| !process\.env\.CSC_KEY_PASSWORD\)/);
  assert.match(script, /config\.publish !== null \|\| config\.win\?\.signAndEditExecutable === false/);
  assert.match(script, /"--publish", "never"/);
  // Outside a dry run only a Windows-validated signature counts.
  assert.match(script, /if \(!dryRun && sig\.status !== "Valid"\)/);
  assert.match(script, /if \(dryRun && !\/\^\[0-9A-F\]\{40\}\$\/\.test\(expectedThumbprint\)\)/);
  assert.doesNotMatch(script, /--publish", "always|GH_TOKEN|GITHUB_TOKEN/);
});

test("signing dry run cannot publish, keeps no certificate and pins its actions", async () => {
  const workflow = await readFile(new URL("../.github/workflows/signing-dry-run.yml", import.meta.url), "utf8");
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(workflow, /upload-artifact|softprops|gh release|secrets\./);
  assert.match(workflow, /Remove throwaway certificate[\s\S]*if: always\(\)/);
  for (const line of workflow.split("\n").filter((l) => /^\s*uses:/.test(l))) {
    assert.match(line, /@[0-9a-f]{40}\b/, `unpinned action: ${line.trim()}`);
  }
  const config = JSON.parse(await readFile(new URL("../desktop/electron-builder.json", import.meta.url), "utf8"));
  assert.equal(config.publish, null);
});
