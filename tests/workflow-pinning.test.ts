import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const workflowDir = fileURLToPath(
  new URL("../.github/workflows/", import.meta.url),
);

interface ActionUse {
  workflow: string;
  action: string;
  ref: string;
  comment: string | null;
}

async function readActionUses(): Promise<ActionUse[]> {
  const files = (await readdir(workflowDir)).filter((name) =>
    /\.ya?ml$/.test(name),
  );
  const uses: ActionUse[] = [];

  for (const file of files) {
    const contents = await readFile(join(workflowDir, file), "utf8");
    const pattern = /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s*#\s*(.+))?$/gm;

    for (const match of contents.matchAll(pattern)) {
      const reference = match[1] ?? "";
      const separator = reference.lastIndexOf("@");
      if (separator === -1) {
        uses.push({
          workflow: file,
          action: reference,
          ref: "",
          comment: match[2]?.trim() ?? null,
        });
        continue;
      }

      uses.push({
        workflow: file,
        action: reference.slice(0, separator),
        ref: reference.slice(separator + 1),
        comment: match[2]?.trim() ?? null,
      });
    }
  }

  return uses;
}

const actionUses = await readActionUses();

test("every workflow action is pinned to an immutable commit SHA", () => {
  assert.equal(actionUses.length > 0, true, "no workflow actions were found");

  for (const use of actionUses) {
    // A tag or branch ref can be moved by the upstream owner; a full commit
    // SHA cannot. QO-SEC-06 requires the immutable form everywhere.
    assert.match(
      use.ref,
      /^[0-9a-f]{40}$/,
      `${use.workflow}: ${use.action} is pinned to "${use.ref}", not a 40-character commit SHA`,
    );
  }
});

test("every pinned action records the human-readable version alongside it", () => {
  for (const use of actionUses) {
    assert.match(
      String(use.comment),
      /^v\d+(\.\d+)*$/,
      `${use.workflow}: ${use.action} must carry a "# vX.Y.Z" comment for review`,
    );
  }
});

test("CodeQL init and analyze always move together", () => {
  const codeql = actionUses.filter((use) =>
    use.action.startsWith("github/codeql-action/"),
  );

  assert.equal(
    codeql.length >= 2,
    true,
    "expected both a CodeQL init and a CodeQL analyze step",
  );

  // Splitting these across versions is the exact failure that broke the
  // CodeQL workflow when init and analyze were upgraded in separate PRs.
  const distinctRefs = new Set(codeql.map((use) => use.ref));
  assert.equal(
    distinctRefs.size,
    1,
    `CodeQL actions must share one SHA, found: ${[...distinctRefs].join(", ")}`,
  );

  const distinctVersions = new Set(codeql.map((use) => use.comment));
  assert.equal(
    distinctVersions.size,
    1,
    `CodeQL actions must share one version, found: ${[...distinctVersions].join(", ")}`,
  );
});
