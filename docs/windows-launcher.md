# Windows one-click startup

On Windows, double-click `start-quotaops.bat` in the QuotaOps repository root. It starts the local collector and dashboard in separate terminal windows, then opens `http://127.0.0.1:3000/` when the dashboard responds.

The launcher checks Node.js 22.14+, npm, `package.json`, `package-lock.json`, and whether required local ports are free. If local dependencies are missing, it installs from the committed lockfile with `npm ci --ignore-scripts --no-audit --no-fund`. That installation downloads packages from the configured npm registry and requires network access. Existing processes on ports 3000 or 4317 are never terminated automatically.

Run `start-quotaops.bat --check` to check prerequisites only. Stop the app using Ctrl+C in each spawned terminal. Initial provider logins remain manual.

Security: the dashboard binds to `127.0.0.1`; the launcher does not configure port forwarding, public hosting, a Windows service, or remote access. Do not expose this unauthenticated dashboard over the network. This script is a convenience launcher, not a security boundary. Windows runtime validation and CI are required before release.
