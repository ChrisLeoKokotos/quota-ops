// Security primitives for the desktop shell, kept apart from Electron so they
// can be driven by real adversarial inputs in tests rather than reasoned about.
//
// Everything here fails closed and returns a reason, so a refusal can be
// asserted on by cause rather than by "it threw something".

"use strict";

const { realpathSync } = require("node:fs");
const path = require("node:path");

/** Schemes a renderer is allowed to hand to the operating system. */
const ALLOWED_EXTERNAL_SCHEMES = new Set(["https:"]);

/**
 * Resolves a request path inside the packaged bundle, or refuses.
 *
 * `candidate.startsWith(root)` is **not** sufficient containment:
 * `C:\app\static-dist-evil\x` starts with `C:\app\static-dist`, so a sibling
 * directory whose name merely begins with the root's name would pass. Path
 * segment comparison via `path.relative` is used instead.
 *
 * Symlinks and Windows reparse points are a second escape: `path.resolve`
 * does not follow them, so a link inside the bundle pointing outside would
 * satisfy any purely textual check and then be read. Both ends are therefore
 * resolved with `realpath` and re-checked.
 */
function resolveStaticAsset(root, pathname, options = {}) {
  const realpath = options.realpath ?? realpathSync;

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false, reason: "malformed_encoding" };
  }

  // A NUL can truncate a path inside a native call.
  if (decoded.includes("\0")) return { ok: false, reason: "null_byte" };

  const trimmed = decoded.replace(/^[/\\]+/, "");
  const requested = trimmed === "" ? "index.html" : trimmed;

  // Reject absolute paths and drive-qualified paths outright rather than
  // letting `resolve` silently discard the base directory.
  if (path.isAbsolute(requested) || /^[a-zA-Z]:/.test(requested)) {
    return { ok: false, reason: "absolute_path" };
  }

  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, requested);
  if (!isInside(resolvedRoot, candidate)) {
    return { ok: false, reason: "outside_bundle" };
  }

  // Re-check after following links. A missing file is not an escape: the
  // caller falls back to the entry document for client-side routing.
  let realRoot;
  try {
    realRoot = realpath(resolvedRoot);
  } catch {
    return { ok: false, reason: "bundle_unavailable" };
  }

  let realCandidate;
  try {
    realCandidate = realpath(candidate);
  } catch {
    return { ok: true, path: candidate, exists: false };
  }

  if (!isInside(realRoot, realCandidate)) {
    return { ok: false, reason: "symlink_escape" };
  }

  return { ok: true, path: realCandidate, exists: true };
}

/** True when `candidate` is the root itself or genuinely beneath it. */
function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (relative === "") return true;
  if (relative.startsWith("..")) return false;
  return !path.isAbsolute(relative);
}

/**
 * Decides whether a URL may be handed to the operating system.
 *
 * `shell.openExternal` launches whatever handler Windows has registered, so
 * an unfiltered call lets a compromised renderer invoke arbitrary protocol
 * handlers. Only https is allowed: the dashboard has no reason to open
 * anything else, and a narrow list is the only kind that stays correct.
 */
function isAllowedExternalUrl(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > 2048) return false;
  if (/[\0\r\n]/.test(value)) return false;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) return false;
  // A credentialed URL in a link is far more likely to be an attack than a
  // legitimate destination.
  if (parsed.username !== "" || parsed.password !== "") return false;
  return parsed.hostname.length > 0;
}

/**
 * Confirms an IPC message came from the application's own top-level window.
 *
 * Without this, any frame the renderer can create — including one a content
 * injection introduces — could invoke the privileged handler. The sender's
 * identity is taken from Electron, never from a value the renderer supplies.
 */
function isTrustedIpcSender(event, expected) {
  if (!event || !expected) return false;

  const sender = event.sender;
  if (!sender || typeof sender.id !== "number") return false;
  if (sender.id !== expected.webContentsId) return false;
  if (typeof sender.isDestroyed === "function" && sender.isDestroyed()) return false;

  // Only the main frame may call. A subframe has a parent.
  const frame = event.senderFrame;
  if (frame) {
    if (frame.parent) return false;
    if (typeof frame.url === "string" && frame.url.length > 0) {
      // `URL.origin` is the string "null" for a non-special scheme such as
      // app:, so comparing origins would reject the application's own frame
      // and accept any other custom-scheme frame. Compare the parts instead.
      let parsed;
      try {
        parsed = new URL(frame.url);
      } catch {
        return false;
      }
      if (`${parsed.protocol}//${parsed.host}` !== expected.origin) return false;
    }
  }

  return true;
}

/**
 * Reads a response body with a hard byte ceiling applied **during** streaming.
 *
 * Checking the length after `response.text()` has already buffered the whole
 * body is not an allocation bound: by then the memory is spent. This aborts
 * once the limit is passed.
 */
async function readBoundedBody(response, maxBytes) {
  const body = response.body;
  if (!body) return { ok: false, reason: "empty_body" };

  const reader = body.getReader();
  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return { ok: false, reason: "read_failed" };
  }

  return { ok: true, text: Buffer.concat(chunks, total).toString("utf8") };
}

/**
 * Builds the renderer's Content-Security-Policy.
 *
 * Inline scripts are allowed by hash so `unsafe-inline` stays out of
 * `script-src`. With no hashes the policy is stricter, not looser: a blank
 * dashboard is a visible failure, a silently widened policy is not.
 *
 * `style-src` keeps `unsafe-inline` because React injects styles at runtime,
 * so their content is not fixed at build time and cannot be hashed. That is a
 * known and much narrower residual than inline scripts would be.
 */
function buildContentSecurityPolicy(scriptHashes = []) {
  const valid = scriptHashes.filter(
    (hash) => typeof hash === "string" && /^sha256-[A-Za-z0-9+/]+=*$/.test(hash),
  );

  return [
    "default-src 'self'",
    ["script-src", "'self'", ...valid.map((hash) => `'${hash}'`)].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'none'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "worker-src 'self'",
  ].join("; ");
}

module.exports = {
  buildContentSecurityPolicy,
  ALLOWED_EXTERNAL_SCHEMES,
  isAllowedExternalUrl,
  isInside,
  isTrustedIpcSender,
  readBoundedBody,
  resolveStaticAsset,
};
