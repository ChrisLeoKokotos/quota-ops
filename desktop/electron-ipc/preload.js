// The entire privileged surface exposed to the renderer.
//
// One read-only call, plus one request to switch token analytics. No
// filesystem access, no collector token, no arbitrary IPC channel, no Node
// APIs. Anything the dashboard cannot do through this object, it cannot do
// at all. Turning token analytics on still needs the person's click in the
// native consent dialog that the main process shows; the renderer can only
// ask for it.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quotaops", {
  version: 1,
  getSnapshot: () => ipcRenderer.invoke("quotaops:snapshot"),
  setTokenAnalytics: (enabled) =>
    ipcRenderer.invoke("quotaops:token-analytics", enabled === true),
});
