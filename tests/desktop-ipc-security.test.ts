import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const security = require("../desktop/electron-ipc/security.js") as {
  buildContentSecurityPolicy: (hashes?: unknown[]) => string;
  isAllowedExternalUrl: (value: unknown) => boolean;
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
    for (const attack of [
      "/../secret.txt",
      "/..%2Fsecret.txt",
      "/%2e%2e%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/a/../../secret.txt",
      "/..\\secret.txt",
      "/%2e%2e%5csecret.txt",
      "/....//secret.txt",
    ]) {
      const result = security.resolveStaticAsset(root, attack);
      if (result.ok) {
        assert.equal(
          security.isInside(resolve(root), result.path),
          true,
          `${attack} resolved outside the bundle: ${result.path}`,
        );
      }
    }
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

test("only https destinations may be handed to the operating system", () => {
  assert.equal(security.isAllowedExternalUrl("https://claude.ai/usage"), true);
  assert.equal(security.isAllowedExternalUrl("https://platform.openai.com/"), true);
});

test("dangerous and unexpected schemes are refused", () => {
  for (const attack of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///C:/Windows/win.ini",
    "vbscript:msgbox(1)",
    "ms-settings:privacy",
    "shell:startup",
    "app://quotaops/index.html",
    "http://example.test/",
    "ftp://example.test/",
    "\u0000https://example.test",
    "https://user:pass@example.test/",
    "https:",
    "not a url",
    "",
  ]) {
    assert.equal(
      security.isAllowedExternalUrl(attack),
      false,
      `${JSON.stringify(attack)} must not be opened externally`,
    );
  }
});

test("a non-string or oversized destination is refused", () => {
  assert.equal(security.isAllowedExternalUrl(null), false);
  assert.equal(security.isAllowedExternalUrl(42), false);
  assert.equal(
    security.isAllowedExternalUrl("https://example.test/" + "a".repeat(3000)),
    false,
  );
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

test("a body is cut off at the limit rather than buffered whole", async () => {
  const oversized = "x".repeat(1_000);
  const response = new Response(oversized);

  assert.deepEqual(await security.readBoundedBody(response, 100), {
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
