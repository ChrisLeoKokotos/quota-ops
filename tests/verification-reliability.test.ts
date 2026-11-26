import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Runs the PowerShell fixture harness for the evidence collector's
 * verification primitives.
 *
 * The primitives exist because the collector previously turned missing and
 * failed work into reported success: a test summary saying "0 failures" was
 * accepted without checking the runner's exit code, and an absent collector
 * was recorded as a passing security assertion. Those are the two cases a
 * reader is most likely to trust and least likely to re-check, so they are
 * pinned here rather than left to inspection.
 */
test("the evidence collector cannot report false success", async (t) => {
  if (process.platform !== "win32") {
    t.skip("the verification harness is PowerShell and runs on Windows");
    return;
  }

  let stdout: string;
  try {
    const result = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(repo, "scripts", "lib", "verification.tests.ps1"),
      ],
      { maxBuffer: 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (error) {
    const failure = error as { stdout?: string };
    assert.fail(
      `the verification harness reported failures:\n${failure.stdout ?? String(error)}`,
    );
  }

  const cases = stdout.split("\n").filter((line) => /^(ok|FAIL)\s/.test(line.trim()));
  assert.equal(
    cases.length >= 18,
    true,
    `expected the harness to run its full set, saw ${cases.length} case(s)`,
  );
  assert.equal(
    cases.some((line) => line.trim().startsWith("FAIL")),
    false,
    `a verification case failed:\n${stdout}`,
  );
  assert.match(stdout, /summary: 0 failure\(s\)/);
});

test("the report script is ASCII and parses under Windows PowerShell 5.1", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell parsing is checked on Windows");
    return;
  }

  // A BOM-less file containing non-ASCII bytes is read as ANSI by Windows
  // PowerShell 5.1 and fails to parse outright. That happened once already
  // and stopped the collector running at all, so it is pinned here.
  const scripts = [
    "scripts/e2e-report.ps1",
    "scripts/lib/verification.ps1",
    "scripts/lib/verification.tests.ps1",
    "scripts/windows-browser-processes.ps1",
    "scripts/windows-security-smoke.ps1",
  ];

  const probe = scripts
    .map(
      (relative) =>
        `$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile(` +
        `'${join(repo, relative).replace(/\\/g, "/")}',[ref]$null,[ref]$e); ` +
        `if($e){ "PARSE-ERROR ${relative}: " + $e[0].Message } else { "ok ${relative}" }`,
    )
    .join("; ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", probe],
    { maxBuffer: 1024 * 1024 },
  );

  assert.equal(
    stdout.includes("PARSE-ERROR"),
    false,
    `a script failed to parse:\n${stdout}`,
  );
  for (const relative of scripts) {
    assert.equal(stdout.includes(`ok ${relative}`), true, `${relative} was not checked`);
  }
});
