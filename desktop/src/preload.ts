import { contextBridge, ipcRenderer } from "electron";
import type { SetupState } from "./setupState";

// Only the app's own setup page gets these. This preload also runs on the
// chat page once the server is up, and that page has no use for them.
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("parleySetup", {
    onState: (listener: (state: SetupState) => void) => {
      ipcRenderer.on("setup:state", (_event, state: SetupState) =>
        listener(state),
      );
      void ipcRenderer.invoke("setup:ready");
    },
    install: () => ipcRenderer.invoke("setup:install"),
    signIn: () => ipcRenderer.invoke("setup:signIn"),
    retry: () => ipcRenderer.invoke("setup:retry"),
    openInstallDocs: () => ipcRenderer.invoke("setup:openInstallDocs"),
    showLogs: () => ipcRenderer.invoke("setup:showLogs"),
  });
}
