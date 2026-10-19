import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const security = require("../desktop/electron-ipc/security.js") as {
  ALLOWED_EXTERNAL_HOSTS: Set<string>;
  MAX_ACCOUNTS: number;
  projectSnapshot: (parsed: Record<string, unknown>) => {
    generatedAt: string | null;
    accounts: { id: string | null; label: string | null; message: string | null; account: { windows: { usedPercent: number | null }[] } | null }[];
    tokens: unknown;
  };
  buildContentSecurityPolicy: (hashes?: unknown[]) => string;
  resolveExternalUrl: (value: unknown) => string | null;
  isInside: (root: string, candidate: string) => boolean;
  isTrustedIpcSender: (event: unknown, expected: unknown) => boolean;
  readBoundedBody: (
    response: Response,
    maxBytes: number,
  ) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
  resolveStaticAsset: (
    root: string,
    pathname: string,
    options?: { realpath?: (p: string) => string },
  ) => { ok: true; path: string; exists: boolean } | { ok: false; reason: string };
};

// --- static asset containment -----------------------------------------------

test("a sibling directory sharing the root's name prefix is refused", () => {
  // The defect this replaces: "C:\app\static-dist-evil\x" starts with
  // "C:\app\static-dist", so a textual prefix check lets a sibling through.
  const root = resolve("C:/app/static-dist");

  assert.equal(security.isInside(root, resolve("C:/app/static-dist-evil/x")), false);
  assert.equal(security.isInside(root, resolve("C:/app/static-dist/x")), true);
  assert.equal(security.isInside(root, root), true);
  assert.equal(security.isInside(root, resolve("C:/app/other")), false);
});

test("traversal is refused in every encoding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quotaops-assets-"));
  const root = join(directory, "static-dist");
  await mkdir(root, { recursive: true });
  await writeFile(join(directory, "secret.txt"), "not for the renderer");
  await writeFile(join(root, "index.html"), "<!doctype html>");

  try {
    // An earlier version wrapped the assertion in `if (result.ok)`, so it
    // claimed only "if accepted, then contained" and would have passed
    // against an implementation that accepted nothing. It now asserts the
    // outcome directly, and checks `exists`, which is the field the protocol
    // handler actually branches on.
    for (const attack of [
      "/../secret.txt",
      "/..%2Fsecret.txt",
      "/%2e%2e%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/a/../../secret.txt",
      "/..\secret.txt",
      "/%2e%2e%5csecret.txt",
      "/....//secret.txt",
      "/%252e%252e/secret.txt",
    ]) {
      const result = security.resolveStaticAsset(root, attack);

      if (result.ok) {
        assert.equal(
          security.isInside(resolve(root), result.path),
          true,
          `${attack} resolved outside the bundle: ${result.path}`,
        );
        assert.equal(
          result.exists,
          false,
          `${attack} resolved to a real file outside the bundle`,
        );
      }
    }

    // The unambiguous cases must be refused outright, by name.
    assert.equal(security.resolveStaticAsset(root, "/../secret.txt").ok, false);
    assert.equal(security.resolveStaticAsset(root, "/a/../../secret.txt").ok, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an absolute or drive-qualified path is refused", () => {
  for (const attack of ["/C:/Windows/win.ini", "/C:\\Windows\\win.ini"]) {
    const result = security.resolveStaticAsset(resolve("C:/app/static-dist"), attack);
    assert.equal(result.ok, false, `${attack} should be refused`);
  }
});

test("malformed percent-encoding and null bytes are refused", () => {
  const root = resolve("C:/app/static-dist");

  assert.deepEqual(security.resolveStaticAsset(root, "/%zz"), {
    ok: false,
    reason: "malformed_encoding",
  });
  assert.deepEqual(security.resolveStaticAsset(root, "/index.html%00.png"), {
    ok: false,
    reason: "null_byte",
  });
});

test("a symlink pointing outside the bundle is refused", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "quotaops-assets-"));
  const root = join(directory, "static-dist");
  await mkdir(root, { recursive: true });
  await writeFile(join(directory, "secret.txt"), "not for the renderer");

  try {
    try {
      await symlink(join(directory, "secret.txt"), join(root, "escape.txt"), "file");
    } catch {
      // Creating a symlink needs privilege or developer mode on Windows.
      t.skip("symlink creation not permitted in this session");
      return;
    }

    const result = security.resolveStaticAsset(root, "/escape.txt");

    assert.deepEqual(
      result,
      { ok: false, reason: "symlink_escape" },
      "a link inside the bundle must not grant access outside it",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("symlink containment is enforced even when the filesystem cannot be used", () => {
  // Injecting realpath proves the control independently of whether this
  // session is allowed to create links.
  const root = resolve("C:/app/static-dist");
  const escaping = (candidate: string) =>
    candidate === resolve(root, "escape.txt") ? resolve("C:/app/secret.txt") : candidate;

  assert.deepEqual(
    security.resolveStaticAsset(root, "/escape.txt", { realpath: escaping }),
    { ok: false, reason: "symlink_escape" },
  );
});

test("an ordinary asset resolves and the empty path becomes the entry document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "quotaops-assets-"));
  const root = join(directory, "static-dist");
  await mkdir(join(root, "_next"), { recursive: true });
  await writeFile(join(root, "index.html"), "<!doctype html>");
  await writeFile(join(root, "_next", "app.js"), "console.log(1)");

  try {
    const entry = security.resolveStaticAsset(root, "/");
    assert.equal(entry.ok, true);
    assert.equal(entry.ok && entry.path.endsWith("index.html"), true);

    const asset = security.resolveStaticAsset(root, "/_next/app.js");
    assert.equal(asset.ok, true);
    assert.equal(asset.ok && asset.exists, true);

    // A missing path is allowed through so the caller can fall back to the
    // entry document for client-side routing, but it is still contained.
    const missing = security.resolveStaticAsset(root, "/accounts/dev-1");
    assert.equal(missing.ok, true);
    assert.equal(missing.ok && missing.exists, false);
    assert.equal(
      missing.ok && security.isInside(resolve(root), missing.path),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// --- external navigation -----------------------------------------------------

test("nothing is handed to the operating system by default", () => {
  // The dashboard contains no external links, so the host allowlist is
  // empty and `shell.openExternal` should never fire. A scheme-only filter
  // let a compromised renderer exfiltrate a snapshot by navigating to
  // https://attacker.test/?d=<data>, which needs no user gesture and no
  // popup permission, and bypassed `connect-src 'none'` entirely.
  assert.equal(security.ALLOWED_EXTERNAL_HOSTS.size, 0);
  assert.equal(security.resolveExternalUrl("https://evil.test/?d=secret"), null);
  assert.equal(security.resolveExternalUrl("https://claude.ai/usage"), null);
});

test("the allowlist is actually consulted, not bypassed", () => {
  // Proves the gate is the allowlist rather than an unconditional refusal:
  // with a host added, that host passes and its neighbours still do not.
  security.ALLOWED_EXTERNAL_HOSTS.add("claude.ai");
  try {
    assert.equal(security.resolveExternalUrl("https://claude.ai/usage"), "https://claude.ai/usage");
    assert.equal(security.resolveExternalUrl("https://evil.test/"), null);
    assert.equal(security.resolveExternalUrl("https://claude.ai.evil.test/"), null);
    assert.equal(security.resolveExternalUrl("https://notclaude.ai/"), null);
    // Host matching is case-insensitive, as DNS is.
    assert.equal(security.resolveExternalUrl("https://CLAUDE.AI/x"), "https://claude.ai/x");
  } finally {
    security.ALLOWED_EXTERNAL_HOSTS.delete("claude.ai");
  }
});

test("dangerous and unexpected schemes are refused", () => {
  security.ALLOWED_EXTERNAL_HOSTS.add("evil.test");
  try {
    for (const attack of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///C:/Windows/win.ini",
      "vbscript:msgbox(1)",
      "ms-settings:privacy",
      "shell:startup",
      "app://quotaops/index.html",
      "http://evil.test/",
      "ftp://evil.test/",
      "https://user:pass@evil.test/",
      "https:",
      "not a url",
      "",
    ]) {
      assert.equal(
        security.resolveExternalUrl(attack),
        null,
        `${JSON.stringify(attack)} must not be opened externally`,
      );
    }
  } finally {
    security.ALLOWED_EXTERNAL_HOSTS.delete("evil.test");
  }
});

test("a destination is validated in the exact form it will be used", () => {
  // `new URL()` strips tabs and leading whitespace and rewrites backslashes.
  // Validating one spelling and handing ShellExecute another would mean the
  // string checked is not the string executed, so control characters are
  // refused outright and anything accepted is returned in its parsed form.
  security.ALLOWED_EXTERNAL_HOSTS.add("evil.test");
  try {
    for (const attack of [
      "ht\tttps://evil.test/",
      "  \thttps://evil.test/",
      "https://ev\ttil.test/",
      "https://evil.test/\u0000",
      "https://evil.test/\n",
    ]) {
      assert.equal(
        security.resolveExternalUrl(attack),
        null,
        `${JSON.stringify(attack)} must be refused rather than normalised`,
      );
    }

    // Backslash normalisation is harmless now: the host check runs on the
    // parsed host and the parsed form is what the caller passes on.
    assert.equal(
      security.resolveExternalUrl("https:\\evil.test/"),
      "https://evil.test/",
      "an accepted URL must come back canonical, not as it was written",
    );
    assert.equal(security.resolveExternalUrl("https://evil.test/a?b=1"), "https://evil.test/a?b=1");
  } finally {
    security.ALLOWED_EXTERNAL_HOSTS.delete("evil.test");
  }
});

test("a non-string or oversized destination is refused", () => {
  assert.equal(security.resolveExternalUrl(null), null);
  assert.equal(security.resolveExternalUrl(42), null);
  assert.equal(security.resolveExternalUrl("https://evil.test/" + "a".repeat(3000)), null);
});

// --- IPC sender identity -----------------------------------------------------

const EXPECTED = { webContentsId: 7, origin: "app://quotaops" };

test("the application's own main frame may invoke the handler", () => {
  const event = {
    sender: { id: 7, isDestroyed: () => false },
    senderFrame: { parent: null, url: "app://quotaops/index.html" },
  };

  assert.equal(security.isTrustedIpcSender(event, EXPECTED), true);
});

test("a different window may not invoke the handler", () => {
  const event = {
    sender: { id: 9, isDestroyed: () => false },
    senderFrame: { parent: null, url: "app://quotaops/index.html" },
  };

  assert.equal(security.isTrustedIpcSender(event, EXPECTED), false);
});

test("a subframe may not invoke the handler", () => {
  const event = {
    sender: { id: 7, isDestroyed: () => false },
    senderFrame: {
      parent: { url: "app://quotaops/index.html" },
      url: "app://quotaops/index.html",
    },
  };

  assert.equal(
    security.isTrustedIpcSender(event, EXPECTED),
    false,
    "an injected iframe must not reach a privileged channel",
  );
});

test("a frame on another origin may not invoke the handler", () => {
  const event = {
    sender: { id: 7, isDestroyed: () => false },
    senderFrame: { parent: null, url: "https://evil.test/" },
  };

  assert.equal(security.isTrustedIpcSender(event, EXPECTED), false);
});

test("a destroyed sender may not invoke the handler", () => {
  const event = {
    sender: { id: 7, isDestroyed: () => true },
    senderFrame: { parent: null, url: "app://quotaops/index.html" },
  };

  assert.equal(security.isTrustedIpcSender(event, EXPECTED), false);
});

test("an absent sender frame is refused, not waved through", () => {
  // Electron documents `senderFrame` as possibly null once a frame has
  // navigated or been destroyed. An earlier version wrapped the parent and
  // origin checks in `if (frame)` with no else, so a null frame skipped both
  // and left only the WebContents id — which every frame in a window shares.
  for (const senderFrame of [undefined, null]) {
    assert.equal(
      security.isTrustedIpcSender(
        { sender: { id: 7, isDestroyed: () => false }, senderFrame },
        EXPECTED,
      ),
      false,
      `senderFrame=${String(senderFrame)} must be refused`,
    );
  }
});

test("a frame with no usable URL is refused", () => {
  for (const frame of [{ parent: null, url: "" }, { parent: null }]) {
    assert.equal(
      security.isTrustedIpcSender(
        { sender: { id: 7, isDestroyed: () => false }, senderFrame: frame },
        EXPECTED,
      ),
      false,
      "a frame whose origin cannot be checked must be refused",
    );
  }
});

test("no sender is trusted before the window identity is assigned", () => {
  const event = {
    sender: { id: 7, isDestroyed: () => false },
    senderFrame: { parent: null, url: "app://quotaops/index.html" },
  };

  assert.equal(security.isTrustedIpcSender(event, null), false);
  assert.equal(security.isTrustedIpcSender(event, undefined), false);
});

test("a malformed or missing sender is refused", () => {
  assert.equal(security.isTrustedIpcSender(null, EXPECTED), false);
  assert.equal(security.isTrustedIpcSender({}, EXPECTED), false);
  assert.equal(security.isTrustedIpcSender({ sender: {} }, EXPECTED), false);
  assert.equal(
    security.isTrustedIpcSender(
      { sender: { id: 7, isDestroyed: () => false }, senderFrame: { parent: null, url: "::::" } },
      EXPECTED,
    ),
    false,
  );
});

// --- bounded response reading ------------------------------------------------

test("an oversized body is refused", async () => {
  // This input is already buffered, so it does not prove streaming — the
  // cancellation test below carries that. Kept for the simple case only.
  assert.deepEqual(await security.readBoundedBody(new Response("x".repeat(1_000)), 100), {
    ok: false,
    reason: "too_large",
  });
});

test("a body within the limit is returned intact", async () => {
  const payload = JSON.stringify({ version: 1, accounts: [] });
  const result = await security.readBoundedBody(new Response(payload), 10_000);

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.text, payload);
});

test("a streamed body that grows past the limit is cancelled mid-stream", async () => {
  let produced = 0;
  let cancelled = false;

  const stream = new ReadableStream({
    pull(controller) {
      produced += 1;
      // Would run forever if the reader did not stop it.
      controller.enqueue(new Uint8Array(1_024));
    },
    cancel() {
      cancelled = true;
    },
  });

  const result = await security.readBoundedBody(new Response(stream), 4_096);

  assert.deepEqual(result, { ok: false, reason: "too_large" });
  assert.equal(cancelled, true, "the stream must be cancelled, not drained");
  assert.equal(produced < 64, true, `reader kept pulling: ${produced} chunks`);
});

// --- content security policy -------------------------------------------------

test("the script policy never contains unsafe-inline", () => {
  const withHashes = security.buildContentSecurityPolicy([
    "sha256-OBTN3RiyCV4Bq7dFqZ5a2pAXjnCcCYeTJMO2I/LYKeo=",
  ]);
  const withoutHashes = security.buildContentSecurityPolicy([]);

  for (const policy of [withHashes, withoutHashes]) {
    const scriptSrc = policy.split("; ").find((d) => d.startsWith("script-src"));
    assert.equal(
      String(scriptSrc).includes("unsafe-inline"),
      false,
      `script-src must not allow inline: ${scriptSrc}`,
    );
    assert.equal(String(scriptSrc).includes("unsafe-eval"), false);
  }
});

test("missing hashes produce a stricter policy, never a wider one", () => {
  // A blank dashboard is a visible failure; a silently widened policy is not.
  const policy = security.buildContentSecurityPolicy([]);
  assert.equal(policy.includes("script-src 'self';"), true);
});

test("a malformed hash is dropped rather than injected into the policy", () => {
  const policy = security.buildContentSecurityPolicy([
    "sha256-valid0000000000000000000000000000000000000=",
    "'self'; script-src *",
    "sha512-wrongalgorithm",
    42 as unknown as string,
    null as unknown as string,
  ]);

  assert.equal(policy.includes("script-src *"), false);
  assert.equal(policy.includes("sha512"), false);
  assert.equal(
    policy.includes("'sha256-valid0000000000000000000000000000000000000='"),
    true,
  );
});

test("the renderer is denied network access and framing", () => {
  const policy = security.buildContentSecurityPolicy([]);

  for (const expected of [
    "connect-src 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ]) {
    assert.equal(policy.includes(expected), true, `policy must contain ${expected}`);
  }
});

// --- snapshot projection -----------------------------------------------------

test("the snapshot is rebuilt field by field, not passed through", () => {
  // Nothing authenticates the peer on 127.0.0.1:4317, so a local process that
  // binds the port first controls the renderer's entire input. An earlier
  // version returned the parsed object whole while claiming otherwise.
  const hostile = {
    version: 1,
    generatedAt: "2026-10-19T00:00:00.000Z",
    __proto__: { polluted: true },
    extraTopLevelKey: "should not survive",
    accounts: [
      {
        id: "dev-1",
        label: "Dev 1",
        status: "ok",
        checkedAt: "2026-10-19T00:00:00.000Z",
        message: null,
        unexpectedKey: "should not survive",
        account: {
          id: "dev-1",
          label: "Dev 1",
          provider: "claude",
          plan: "Max",
          updatedAt: "2026-10-19T00:00:00.000Z",
          secretToken: "should not survive",
          windows: [{ id: "5h", label: "5 hour", usedPercent: 42, resetAt: null, extra: 1 }],
        },
      },
    ],
    tokens: null,
  };

  const projected = security.projectSnapshot(hostile);
  const serialized = JSON.stringify(projected);

  assert.equal(serialized.includes("should not survive"), false);
  assert.equal(serialized.includes("secretToken"), false);
  assert.equal(serialized.includes("extraTopLevelKey"), false);
  assert.equal(Object.hasOwn(projected, "extraTopLevelKey"), false);
  assert.equal(projected.accounts[0]?.account?.windows[0]?.usedPercent, 42);
});

test("collector-controlled strings are length-bounded", () => {
  const projected = security.projectSnapshot({
    version: 1,
    generatedAt: "x".repeat(5_000),
    accounts: [
      {
        id: "a".repeat(5_000),
        label: "b".repeat(5_000),
        status: "ok",
        message: "c".repeat(5_000),
        account: null,
      },
    ],
    tokens: null,
  });

  assert.equal(projected.generatedAt?.length, 64);
  assert.equal(projected.accounts[0]?.id?.length, 64);
  assert.equal(projected.accounts[0]?.label?.length, 128);
  assert.equal(projected.accounts[0]?.message?.length, 512);
});

test("account and window counts are capped", () => {
  const projected = security.projectSnapshot({
    version: 1,
    generatedAt: null,
    accounts: Array.from({ length: 500 }, (_unused, index) => ({
      id: `acct-${index}`,
      account: {
        windows: Array.from({ length: 200 }, (_w, i) => ({ id: `w${i}`, usedPercent: 1 })),
      },
    })),
    tokens: null,
  });

  assert.equal(projected.accounts.length, security.MAX_ACCOUNTS);
  assert.equal(projected.accounts[0]?.account?.windows.length, 16);
});

test("non-string and non-finite values are dropped rather than forwarded", () => {
  const projected = security.projectSnapshot({
    version: 1,
    generatedAt: { toString: () => "nope" },
    accounts: [
      {
        id: 42,
        label: ["array"],
        account: { windows: [{ id: "w", usedPercent: Number.NaN }, "not an object"] },
      },
      "not an object",
    ],
    tokens: "not an object",
  });

  assert.equal(projected.generatedAt, null);
  assert.equal(projected.accounts[0]?.id, null);
  assert.equal(projected.accounts[0]?.label, null);
  assert.equal(projected.accounts[0]?.account?.windows[0]?.usedPercent, null);
  assert.equal(projected.accounts[1]?.account, null);
  assert.equal(projected.tokens, null);
});
