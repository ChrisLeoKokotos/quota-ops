import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

test("static export ignores stale Next dev route imports without disabling type errors", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "quotaops-static-types-"));
  try {
    // Use the actual checked-in build config and strict base config.
    for (const name of ["tsconfig.json", "tsconfig.static.json"]) {
      await writeFile(
        join(fixture, name),
        await readFile(new URL(`../${name}`, import.meta.url), "utf8"),
      );
    }
    await mkdir(join(fixture, ".next", "dev", "types"), { recursive: true });
    await mkdir(join(fixture, ".next-static", "types"), { recursive: true });
    await mkdir(join(fixture, "app"), { recursive: true });
    await writeFile(join(fixture, "app", "page.ts"), "export const page = true;\n");
    // A stale Next dev validator references app/api route files absent from
    // the static export, reproducing the exact user's TS2307 symptom.
    await writeFile(
      join(fixture, ".next", "dev", "types", "validator.ts"),
      'import "../../../app/api/collector/capability/route.js";\n',
    );
    // A genuine TypeScript error in *static* generated types must still fail.
    await writeFile(
      join(fixture, ".next-static", "types", "validator.ts"),
      'export const invalid: number = "wrong";\n',
    );

    const configPath = join(fixture, "tsconfig.static.json");
    const input = ts.readConfigFile(configPath, ts.sys.readFile);
    assert.equal(input.error, undefined);
    const config = ts.parseJsonConfigFileContent(input.config, ts.sys, fixture, undefined, configPath);
    assert.equal(config.errors.length, 0, ts.formatDiagnostics(config.errors, {
      getCurrentDirectory: () => fixture,
      getCanonicalFileName: (file) => file,
      getNewLine: () => "\n",
    }));

    const files = config.fileNames.map((file) => file.replace(/\\/g, "/"));
    assert.ok(files.some((file) => file.endsWith("/app/page.ts")));
    assert.ok(files.some((file) => file.endsWith("/.next-static/types/validator.ts")));
    assert.ok(!files.some((file) => file.includes("/.next/dev/types/")));
    assert.equal(config.options.strict, true);
    assert.equal(config.options.noUncheckedIndexedAccess, true);
    assert.equal(config.options.noEmit, true);

    const program = ts.createProgram(config.fileNames, config.options);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === 2322),
      "An intentional static type error must remain visible");
    assert.ok(!diagnostics.some((diagnostic) => diagnostic.code === 2307),
      "Stale dev validator must never break the static build");

    const nextConfigSource = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
    assert.match(nextConfigSource, /typescript:\s*\{\s*tsconfigPath:\s*"tsconfig.static.json"\s*\}/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
