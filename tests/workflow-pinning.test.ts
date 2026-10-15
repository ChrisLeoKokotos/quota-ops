import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const workflowDir = fileURLToPath(
  new URL("../.github/workflows/", import.meta.url),
);

const CODEQL_INIT = "github/codeql-action/init";
const CODEQL_ANALYZE = "github/codeql-action/analyze";

interface ActionUse {
  workflow: string;
  action: string;
  ref: string;
  comment: string | null;
  /**
   * A checked-in action or reusable workflow (`uses: ./…`). It resolves from
   * the checked-out tree, so there is no external ref to pin.
   * `.github/workflows/repository-guard.yml` excludes these from its own grep
   * for the same reason.
   */
  local: boolean;
}

function parseActionUses(contents: string, workflow: string): ActionUse[] {
  const pattern = /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s*#\s*(.+))?$/gm;
  const uses: ActionUse[] = [];

  for (const match of contents.matchAll(pattern)) {
    const reference = match[1] ?? "";
    const comment = match[2]?.trim() ?? null;

    if (reference.startsWith("./") || reference.startsWith("../")) {
      uses.push({ workflow, action: reference, ref: "", comment, local: true });
      continue;
    }

    const separator = reference.lastIndexOf("@");
    uses.push({
      workflow,
      action: separator === -1 ? reference : reference.slice(0, separator),
      ref: separator === -1 ? "" : reference.slice(separator + 1),
      comment,
      local: false,
    });
  }

  return uses;
}

/** Pin and version-comment requirements, applied to external actions only. */
function pinningViolations(uses: ActionUse[]): string[] {
  const violations: string[] = [];

  for (const use of uses) {
    if (use.local) continue;

    if (!/^[0-9a-f]{40}$/.test(use.ref)) {
      violations.push(
        `${use.workflow}: ${use.action} is pinned to "${use.ref}", not a 40-character commit SHA`,
      );
    }
    if (!/^v\d+(\.\d+)*$/.test(String(use.comment))) {
      violations.push(
        `${use.workflow}: ${use.action} must carry a "# vX.Y.Z" comment for review`,
      );
    }
  }

  return violations;
}

/**
 * CodeQL requires `init` and `analyze` to run the same action version within a
 * workflow. Counting `github/codeql-action/*` entries is not enough: with an
 * `autobuild` step present, deleting `analyze` leaves two matching entries that
 * agree on version while no analysis runs at all. Check the step names.
 */
function codeqlViolations(uses: ActionUse[]): string[] {
  const violations: string[] = [];
  const workflows = [
    ...new Set(
      uses
        .filter((use) => use.action.startsWith("github/codeql-action/"))
        .map((use) => use.workflow),
    ),
  ];

  if (workflows.length === 0) {
    return ["no workflow runs github/codeql-action"];
  }

  for (const workflow of workflows) {
    const steps = uses.filter(
      (use) =>
        use.workflow === workflow &&
        use.action.startsWith("github/codeql-action/"),
    );

    for (const required of [CODEQL_INIT, CODEQL_ANALYZE]) {
      if (!steps.some((step) => step.action === required)) {
        violations.push(`${workflow}: missing a ${required} step`);
      }
    }

    const refs = new Set(steps.map((step) => step.ref));
    if (refs.size > 1) {
      violations.push(
        `${workflow}: CodeQL actions must share one SHA, found: ${[...refs].join(", ")}`,
      );
    }

    const versions = new Set(steps.map((step) => String(step.comment)));
    if (versions.size > 1) {
      violations.push(
        `${workflow}: CodeQL actions must share one version, found: ${[...versions].join(", ")}`,
      );
    }
  }

  return violations;
}

async function readRepositoryUses(): Promise<ActionUse[]> {
  const files = (await readdir(workflowDir)).filter((name) =>
    /\.ya?ml$/.test(name),
  );
  const uses: ActionUse[] = [];

  for (const file of files) {
    const contents = await readFile(join(workflowDir, file), "utf8");
    uses.push(...parseActionUses(contents, file));
  }

  return uses;
}

const repositoryUses = await readRepositoryUses();

// --- the repository's own workflows -----------------------------------------

test("every external workflow action is pinned and version-commented", () => {
  assert.equal(repositoryUses.length > 0, true, "no workflow actions were found");
  assert.deepEqual(pinningViolations(repositoryUses), []);
});

test("the repository runs both CodeQL steps at one version", () => {
  assert.deepEqual(codeqlViolations(repositoryUses), []);
});

// --- local references --------------------------------------------------------

const LOCAL_WORKFLOW = [
  "jobs:",
  "  build:",
  "    steps:",
  "      - uses: ./.github/actions/setup",
  "      - uses: ./.github/actions/build",
  "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "  reusable:",
  "    uses: ./.github/workflows/shared.yml",
  "",
].join("\n");

test("local actions and reusable workflows are recognised as local", () => {
  const uses = parseActionUses(LOCAL_WORKFLOW, "local.yml");
  const local = uses.filter((use) => use.local).map((use) => use.action);

  assert.deepEqual(local, [
    "./.github/actions/setup",
    "./.github/actions/build",
    "./.github/workflows/shared.yml",
  ]);
});

test("local references are exempt from the external pinning requirements", () => {
  // They resolve from the checked-out tree, so there is no external SHA to pin.
  assert.deepEqual(
    pinningViolations(parseActionUses(LOCAL_WORKFLOW, "local.yml")),
    [],
  );
});

test("a parent-relative local reference is also exempt", () => {
  const uses = parseActionUses("      - uses: ../shared/action\n", "local.yml");

  assert.equal(uses[0]?.local, true);
  assert.deepEqual(pinningViolations(uses), []);
});

// --- external pinning regressions -------------------------------------------

test("an external action pinned to a tag is rejected", () => {
  const violations = pinningViolations(
    parseActionUses("      - uses: actions/checkout@v4 # v4\n", "bad.yml"),
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /not a 40-character commit SHA/);
});

test("an external action pinned to a branch or short SHA is rejected", () => {
  for (const reference of [
    "actions/checkout@main # v7.0.1",
    "actions/checkout@3d3c42e # v7.0.1",
    "actions/checkout # v7.0.1",
  ]) {
    const violations = pinningViolations(
      parseActionUses(`      - uses: ${reference}\n`, "bad.yml"),
    );

    assert.equal(
      violations.some((item) => item.includes("40-character commit SHA")),
      true,
      `expected ${reference} to be rejected`,
    );
  }
});

test("an external action without a version comment is rejected", () => {
  const violations = pinningViolations(
    parseActionUses(
      "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n",
      "bad.yml",
    ),
  );

  assert.equal(violations.length, 1);
  assert.match(violations[0] ?? "", /# vX\.Y\.Z/);
});

// --- CodeQL step regressions -------------------------------------------------

const SHA_A = "24c54180a607b1449ed407dd24f251e4e9147c8d";
const SHA_B = "2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2";

function codeqlWorkflow(steps: string[]): ActionUse[] {
  return parseActionUses(steps.join("\n") + "\n", "codeql.yml");
}

test("a complete CodeQL workflow passes", () => {
  const uses = codeqlWorkflow([
    `      - uses: ${CODEQL_INIT}@${SHA_A} # v4.38.3`,
    `      - uses: ${CODEQL_ANALYZE}@${SHA_A} # v4.38.3`,
  ]);

  assert.deepEqual(codeqlViolations(uses), []);
});

test("an autobuild step cannot stand in for the analyze step", () => {
  // The exact gap the previous count-based check missed: two matching entries
  // that agree on version while no analysis is performed.
  const uses = codeqlWorkflow([
    `      - uses: ${CODEQL_INIT}@${SHA_A} # v4.38.3`,
    `      - uses: github/codeql-action/autobuild@${SHA_A} # v4.38.3`,
  ]);

  assert.deepEqual(codeqlViolations(uses), [
    `codeql.yml: missing a ${CODEQL_ANALYZE} step`,
  ]);
});

test("a missing init step is rejected", () => {
  const uses = codeqlWorkflow([
    `      - uses: github/codeql-action/autobuild@${SHA_A} # v4.38.3`,
    `      - uses: ${CODEQL_ANALYZE}@${SHA_A} # v4.38.3`,
  ]);

  assert.deepEqual(codeqlViolations(uses), [
    `codeql.yml: missing a ${CODEQL_INIT} step`,
  ]);
});

test("mismatched CodeQL SHAs are rejected", () => {
  const uses = codeqlWorkflow([
    `      - uses: ${CODEQL_INIT}@${SHA_A} # v4.38.3`,
    `      - uses: ${CODEQL_ANALYZE}@${SHA_B} # v4.38.3`,
  ]);

  assert.equal(
    codeqlViolations(uses).some((item) => item.includes("must share one SHA")),
    true,
  );
});

test("mismatched CodeQL version comments are rejected", () => {
  const uses = codeqlWorkflow([
    `      - uses: ${CODEQL_INIT}@${SHA_A} # v4.38.3`,
    `      - uses: ${CODEQL_ANALYZE}@${SHA_A} # v4.38.2`,
  ]);

  assert.equal(
    codeqlViolations(uses).some((item) =>
      item.includes("must share one version"),
    ),
    true,
  );
});

test("a repository with no CodeQL workflow at all is rejected", () => {
  const uses = parseActionUses(
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n",
    "ci.yml",
  );

  assert.deepEqual(codeqlViolations(uses), [
    "no workflow runs github/codeql-action",
  ]);
});

test("CodeQL steps are checked per workflow, not across the repository", () => {
  // init in one workflow and analyze in another is not a working analysis.
  const uses = [
    ...parseActionUses(
      `      - uses: ${CODEQL_INIT}@${SHA_A} # v4.38.3\n`,
      "a.yml",
    ),
    ...parseActionUses(
      `      - uses: ${CODEQL_ANALYZE}@${SHA_A} # v4.38.3\n`,
      "b.yml",
    ),
  ];

  assert.deepEqual(codeqlViolations(uses), [
    `a.yml: missing a ${CODEQL_ANALYZE} step`,
    `b.yml: missing a ${CODEQL_INIT} step`,
  ]);
});
