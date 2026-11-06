import { contextBridge, ipcRenderer } from "electron";
import type { PhoneState, PhoneSummary } from "./phoneState";
import type { SetupState } from "./setupState";

// Only the app's own pages get these. This preload also runs on the chat page
// once the server is up, which gets only what's at the bottom: it can open the
// phone access window and read its summary, and turning access on takes a click
// in that window, where no page the server serves can reach.
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
  contextBridge.exposeInMainWorld("parleyPhone", {
    onState: (listener: (state: PhoneState) => void) => {
      ipcRenderer.on("phone:state", (_event, state: PhoneState) =>
        listener(state),
      );
      void ipcRenderer.invoke("phone:ready").then(listener);
    },
    turnOn: () => ipcRenderer.invoke("phone:turnOn"),
    turnOff: () => ipcRenderer.invoke("phone:turnOff"),
    check: () => ipcRenderer.invoke("phone:check"),
    copyAddress: () => ipcRenderer.invoke("phone:copyAddress"),
    openDownload: () => ipcRenderer.invoke("phone:openDownload"),
    openEnableHttps: () => ipcRenderer.invoke("phone:openEnableHttps"),
  });
} else {
  contextBridge.exposeInMainWorld("parleyDesktop", {
    openPhoneAccess: () => ipcRenderer.invoke("phone:open"),
    phoneSummary: (): Promise<PhoneSummary> =>
      ipcRenderer.invoke("phone:summary"),
    onPhoneSummary: (listener: (summary: PhoneSummary) => void) => {
      const handler = (_event: unknown, summary: PhoneSummary) =>
        listener(summary);
      ipcRenderer.on("phone:summary", handler);
      return () => void ipcRenderer.removeListener("phone:summary", handler);
    },
  });
}
