// The entire privileged surface exposed to the renderer.
//
// One read-only call. No filesystem access, no collector token, no arbitrary
// IPC channel, no Node APIs. Anything the dashboard cannot do through this
// object, it cannot do at all.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("quotaops", {
  version: 1,
  getSnapshot: () => ipcRenderer.invoke("quotaops:snapshot"),
});
