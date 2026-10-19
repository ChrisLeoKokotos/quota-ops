// Stub collector returning a realistic snapshot, to prove the IPC path end to end.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const token = (await readFile(join(homedir(), ".quotaops", "collector.token"), "utf8")).trim();
const snapshot = {
  version: 1,
  generatedAt: new Date().toISOString(),
  accounts: [
    { id: "dev-1", label: "Dev 1", status: "ok", checkedAt: new Date().toISOString(), message: null,
      account: { id: "dev-1", label: "Dev 1", provider: "claude", plan: "Max", updatedAt: new Date().toISOString(),
        windows: [{ id: "5h", label: "5 hour", usedPercent: 42, resetAt: new Date(Date.now()+3.6e6).toISOString() }] } },
  ],
  tokens: null,
};
createServer((req, res) => {
  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${token}`) { res.statusCode = 401; res.end('{"error":"unauthorized"}'); return; }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(req.url === "/health" ? { status: "ok", collecting: false } : snapshot));
}).listen(4317, "127.0.0.1", () => process.stdout.write("stub collector on 4317\n"));
