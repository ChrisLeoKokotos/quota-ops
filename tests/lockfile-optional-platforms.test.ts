import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// npm 11 rejects a lockfile in `npm ci` when a locked package declares an
// optional dependency that has no lock entry of its own, even if that optional
// package targets another platform. npm 10 tolerated the gap, so a lockfile
// written on one platform with its foreign `@img/sharp-*` entries pruned
// installed in CI (npm 10.9.4) but failed for npm 11 users. These checks keep
// both lockfiles complete for every platform.

type LockEntry = {
  version?: string;
  resolved?: string;
  integrity?: string;
  optional?: boolean;
  extraneous?: boolean;
  link?: boolean;
  os?: string[];
  cpu?: string[];
  libc?: string[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type Lockfile = {
  lockfileVersion: number;
  packages: Record<string, LockEntry>;
};

const LOCKFILES = ["package-lock.json", "desktop/electron-ipc/package-lock.json"];

async function readLockfile(path: string): Promise<Lockfile> {
  return JSON.parse(
    await readFile(new URL(`../${path}`, import.meta.url), "utf8"),
  ) as Lockfile;
}

/** Node module resolution over lockfile keys: nearest `node_modules/<name>` up the tree. */
function resolveEntry(
  packages: Lockfile["packages"],
  from: string,
  name: string,
): string | null {
  let base = from;
  for (;;) {
    const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const parent = base.lastIndexOf("/node_modules/");
    base = parent === -1 ? "" : base.slice(0, parent);
  }
}

function isSharpEntry(key: string): boolean {
  return key === "node_modules/sharp" || key.endsWith("/node_modules/sharp");
}

for (const path of LOCKFILES) {
  test(`${path}: locks sharp whenever a locked package declares it`, async () => {
    const { lockfileVersion, packages } = await readLockfile(path);
    assert.equal(lockfileVersion, 3);

    const declarers = Object.entries(packages)
      .filter(([, entry]) => !entry.extraneous)
      .filter(
        ([, entry]) =>
          entry.dependencies?.sharp !== undefined ||
          entry.optionalDependencies?.sharp !== undefined,
      )
      .map(([key]) => key);

    for (const declarer of declarers) {
      assert.notEqual(
        resolveEntry(packages, declarer, "sharp"),
        null,
        `${declarer || "<root>"} declares sharp but the lockfile has no sharp entry`,
      );
    }
  });

  test(`${path}: every sharp platform package has its own lock entry`, async () => {
    const { packages } = await readLockfile(path);
    const missing: string[] = [];

    for (const [sharpKey, sharp] of Object.entries(packages)) {
      if (!isSharpEntry(sharpKey)) continue;

      const platforms = Object.entries(sharp.optionalDependencies ?? {});
      assert.equal(platforms.length > 0, true, `${sharpKey} lists no platform packages`);

      for (const [name, version] of platforms) {
        const key = resolveEntry(packages, sharpKey, name);
        if (!key) {
          missing.push(`${name}@${version}`);
          continue;
        }

        const entry = packages[key] as LockEntry;
        assert.equal(entry.version, version, `${key} must be the version sharp pins`);
        assert.equal(entry.optional, true, `${key} must stay optional`);
        assert.equal(
          entry.resolved,
          `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${version}.tgz`,
          `${key} must resolve from the public registry`,
        );
        assert.match(String(entry.integrity), /^sha512-/, `${key} needs an integrity hash`);
        assert.equal(
          Boolean(entry.os?.length || entry.cpu?.length),
          true,
          `${key} must keep its os/cpu restriction so other platforms skip it`,
        );
        if (name.includes("-linuxmusl-")) {
          assert.deepEqual(entry.libc, ["musl"], `${key} must target musl`);
        } else if (name.includes("-linux-")) {
          assert.deepEqual(entry.libc, ["glibc"], `${key} must target glibc`);
        }
      }
    }

    assert.deepEqual(missing, [], "sharp platform packages missing from the lockfile");
  });

  test(`${path}: every locked dependency resolves to a lock entry`, async () => {
    // The same completeness rule npm 11 applies in `npm ci`, for every package,
    // so a pruned transitive entry (for example @emnapi/runtime under
    // @img/sharp-wasm32) is caught as well.
    const { packages } = await readLockfile(path);
    const missing: string[] = [];

    for (const [key, entry] of Object.entries(packages)) {
      if (entry.extraneous || entry.link) continue;

      const edges = {
        ...entry.dependencies,
        ...entry.optionalDependencies,
        ...(key === "" ? entry.devDependencies : {}),
      };
      for (const [name, spec] of Object.entries(edges)) {
        if (!resolveEntry(packages, key, name)) {
          missing.push(`${key || "<root>"} -> ${name}@${spec}`);
        }
      }
    }

    assert.deepEqual(missing, []);
  });
}
