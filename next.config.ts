import type { NextConfig } from "next";

const isDevelopment = process.env.NODE_ENV !== "production";

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
];

/**
 * The desktop build exports the dashboard as static assets. There is no
 * Next.js server in that mode: the Electron main process talks to the
 * collector directly and the renderer reaches it over a narrow IPC bridge,
 * which removes both the ~100 MB server process and the dashboard's HTTP
 * listener. Security headers are applied by the Electron session instead,
 * since `headers()` has no effect on an exported build.
 */
const isStaticExport = process.env.QUOTAOPS_STATIC === "1";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  ...(isStaticExport
    ? {
        output: "export" as const,
        distDir: ".next-static",
        // Assets are served from a custom scheme root, so relative paths keep
        // working regardless of where the bundle is installed.
        assetPrefix: "./",
        images: { unoptimized: true },
      }
    : {}),
  // Next writes AGENTS.md and CLAUDE.md into the repository root on every dev
  // run. They are untracked generated files and only add noise to git status.
  agentRules: false,
  reactStrictMode: true,
  ...(isStaticExport
    ? {}
    : {
        async headers() {
          return [
            {
              source: "/:path*",
              headers: securityHeaders,
            },
          ];
        },
      }),
};

export default nextConfig;
