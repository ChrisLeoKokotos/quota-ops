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
 * Hosts the dashboard is allowed to open in the user's browser.
 *
 * **Currently empty, deliberately.** The dashboard contains no external links
 * today, so nothing should ever reach `shell.openExternal`. An allowlist with
 * no entries is the correct expression of that, and it closes a real hole: a
 * scheme-only filter let a compromised renderer exfiltrate a snapshot by
 * navigating to `https://attacker.test/?d=<data>`, which `will-navigate`
 * would hand straight to ShellExecute. A top-level navigation needs no popup
 * permission and no user gesture, so that was unlimited egress past
 * `connect-src 'none'` — and it drove the user's own browser, where the
 * provider sessions live.
 *
 * Add a host here only when the UI actually links to it.
 */
const ALLOWED_EXTERNAL_HOSTS = new Set([]);

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

  // NTFS alternate data streams. "index.html:hidden" and "index.html::$DATA"
  // both resolve to a real file inside the bundle, so containment still
  // holds — but the stream spelling defeats any check keyed on the file name,
  // and `realpath` preserves the suffix so the escape check cannot see past
  // it. A colon has no legitimate use in a request path here.
  if (decoded.includes(":")) return { ok: false, reason: "stream_suffix" };

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
 * Decides whether a URL may be handed to the operating system, and returns
 * the exact string to pass on.
 *
 * Returning the parsed form matters: `new URL()` strips ASCII tabs and
 * leading whitespace and rewrites backslashes, so validating one spelling and
 * then passing the raw one to ShellExecute means the thing checked is not the
 * thing executed. `"ht<tab>tps://evil.test/"` parses as https but is not what
 * the caller held.
 */
function resolveExternalUrl(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > 2048) return null;
  if (/[\0\r\n\t\u0000-\u0020]/.test(value)) return null;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) return null;
  // A credentialed URL in a link is far likelier to be an attack than a
  // legitimate destination.
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.hostname.length === 0) return null;
  if (!ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  return parsed.href;
}

/** Back-compat predicate; prefer `resolveExternalUrl`, which returns the URL. */
function isAllowedExternalUrl(value) {
  return resolveExternalUrl(value) !== null;
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

  // Only the main frame may call. Electron documents `senderFrame` as
  // possibly null once a frame has navigated or been destroyed, so an absent
  // frame must be refused outright: treating it as "no frame to object to"
  // skips the parent and origin checks and leaves only the WebContents id,
  // which every frame in the window shares.
  const frame = event.senderFrame;
  if (!frame) return false;
  {
    if (frame.parent) return false;
    // An empty URL cannot be matched against the expected origin, so it is
    // refused rather than waved through.
    if (typeof frame.url !== "string" || frame.url.length === 0) return false;
    {
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

const MAX_ACCOUNTS = 64;
const MAX_WINDOWS_PER_ACCOUNT = 16;

/** Truncates a collector-supplied string, or drops it if it is not one. */
function boundedText(value, maxLength) {
  if (typeof value !== "string") return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/**
 * Rebuilds the snapshot field by field before it crosses IPC.
 *
 * An earlier version returned `parsed` whole while a comment claimed the
 * renderer was handed "a shape it can rely on". It was not: every
 * collector-controlled string and any extra key travelled verbatim. Nothing
 * authenticates the peer on 127.0.0.1:4317, so a local process that binds the
 * port first controls the renderer's entire input.
 *
 * React escapes text, so this is not an XSS fix. It bounds what an
 * impersonating peer can put in front of the user, and keeps unknown keys out
 * of the renderer entirely.
 */
function projectSnapshot(parsed) {
  return {
    version: 1,
    generatedAt: boundedText(parsed.generatedAt, 64),
    accounts: parsed.accounts.slice(0, MAX_ACCOUNTS).map((entry) => {
      const source = entry && typeof entry === "object" ? entry : {};
      const account =
        source.account && typeof source.account === "object" ? source.account : null;

      return {
        id: boundedText(source.id, 64),
        label: boundedText(source.label, 128),
        status: boundedText(source.status, 32),
        checkedAt: boundedText(source.checkedAt, 64),
        message: boundedText(source.message, 512),
        account: account
          ? {
              id: boundedText(account.id, 64),
              label: boundedText(account.label, 128),
              provider: boundedText(account.provider, 32),
              plan: boundedText(account.plan, 64),
              email: boundedText(account.email, 128),
              updatedAt: boundedText(account.updatedAt, 64),
              windows: Array.isArray(account.windows)
                ? account.windows.slice(0, MAX_WINDOWS_PER_ACCOUNT).map((candidate) => {
                    const window =
                      candidate && typeof candidate === "object" ? candidate : {};
                    return {
                      id: boundedText(window.id, 64),
                      label: boundedText(window.label, 128),
                      usedPercent:
                        typeof window.usedPercent === "number" &&
                        Number.isFinite(window.usedPercent)
                          ? window.usedPercent
                          : null,
                      resetAt: boundedText(window.resetAt, 64),
                    };
                  })
                : [],
            }
          : null,
      };
    }),
    // Token analytics are numeric aggregates, and the client's own parser
    // drops the whole block if any field is wrong.
    tokens: parsed.tokens && typeof parsed.tokens === "object" ? parsed.tokens : null,
  };
}

module.exports = {
  MAX_ACCOUNTS,
  projectSnapshot,
  ALLOWED_EXTERNAL_HOSTS,
  buildContentSecurityPolicy,
  ALLOWED_EXTERNAL_SCHEMES,
  isAllowedExternalUrl,
  isInside,
  isTrustedIpcSender,
  readBoundedBody,
  resolveExternalUrl,
  resolveStaticAsset,
};
