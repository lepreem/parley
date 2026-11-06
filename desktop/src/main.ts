import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  powerSaveBlocker,
  shell,
  systemPreferences,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from "electron";
import { claudeStatus, installerCommand, runSetupStep } from "./claudeCode";
import { codexStatus } from "./codex";
import { isPermitted } from "./permissions";
import { PhoneAccess } from "./phoneAccess";
import { phoneSummary, type PhoneState } from "./phoneState";
import { qrFor } from "./qr";
import { ServerStartError, startServer, type RunningServer } from "./server";
import type { SetupState } from "./setupState";
import { userPath } from "./shellPath";
import { readTailscale, startServe } from "./tailscale";
import { newerRelease } from "./updates";
import { installYtDlp, updateYtDlp } from "./ytDlp";

const INSTALL_DOCS = "https://code.claude.com/docs/en/setup";
const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

/** Where the app keeps its files, the same place a server started by hand does. */
const dataDir = process.env.DATA_DIR ?? path.join(homedir(), ".parley");

/** What the build put next to the app: the server, the client and yt-dlp. */
const resources = app.isPackaged
  ? process.resourcesPath
  : path.join(app.getAppPath(), "build");

const setupPage = path.join(app.getAppPath(), "static", "setup.html");
const phonePage = path.join(app.getAppPath(), "static", "phone.html");
const phoneSettings = path.join(dataDir, "phone-access.json");

let window: BrowserWindow | undefined;
let server: RunningServer | undefined;
let searchPath = "";
let setupState: SetupState = { screen: "starting" };
/** The setup program running now, which a retry stops. */
let setupStep: { kill(): boolean } | undefined;
let quitting = false;
/** Stops a second click starting a second server while the first starts. */
let advancing = false;
let phoneWindow: BrowserWindow | undefined;
/** Keeps the machine from sleeping while a phone may want it. */
let awakeBlocker: number | undefined;

function stayAwake(awake: boolean) {
  if (awake) {
    awakeBlocker ??= powerSaveBlocker.start("prevent-app-suspension");
  } else if (awakeBlocker !== undefined) {
    powerSaveBlocker.stop(awakeBlocker);
    awakeBlocker = undefined;
  }
}

const phoneAccess = new PhoneAccess({
  loadEnabled: () => {
    try {
      const saved = JSON.parse(readFileSync(phoneSettings, "utf8")) as {
        enabled?: unknown;
      };
      return saved.enabled === true;
    } catch {
      return false;
    }
  },
  saveEnabled: (enabled) => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(phoneSettings, JSON.stringify({ enabled }));
  },
  readTailscale: () => readTailscale(searchPath),
  startServe: (program, port, onOutput, onExit) =>
    startServe(program, port, searchPath, onOutput, onExit),
  allow: (access) => server?.allowPhoneAccess(access),
  qrFor,
  onChange: (state: PhoneState) => {
    stayAwake(state.status === "on");
    phoneWindow?.webContents.send("phone:state", state);
    window?.webContents.send("phone:summary", phoneSummary(state));
  },
});

function isHttp(url: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function showSetup(state: SetupState) {
  setupState = state;
  if (!window) return;
  // The setup page asks for the latest state when it loads, so a window still
  // loading it misses nothing here.
  if (window.webContents.getURL().startsWith("http")) {
    void window.loadFile(setupPage);
  } else {
    window.webContents.send("setup:state", state);
  }
}

function createWindow() {
  const created = new BrowserWindow({
    title: "Parley",
    width: 1200,
    height: 800,
    minWidth: 420,
    minHeight: 480,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1b1f" : "#fbfbf9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  window = created;
  created.on("closed", () => {
    window = undefined;
  });

  // The app shows its own pages. A link to anywhere else opens in the browser,
  // which is also where a page the person didn't choose can do the least.
  // Loading the setup page doesn't count as navigating, so no page can reach
  // another file, and the only file: page that ever runs here is that one.
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  created.webContents.on("will-navigate", (event, url) => {
    if (server && url.startsWith(`${server.url}/`)) return;
    event.preventDefault();
    if (isHttp(url)) void shell.openExternal(url);
  });
  created.webContents.session.setPermissionRequestHandler(
    (_contents, permission, callback, details) => {
      if (!isPermitted(permission, details, server?.url)) {
        callback(false);
      } else if (permission === "media" && process.platform === "darwin") {
        // A Mac asks the person itself, the first time.
        systemPreferences
          .askForMediaAccess("microphone")
          .then(callback, () => callback(false));
      } else {
        callback(true);
      }
    },
  );
  // Electron has no right-click menu of its own.
  created.webContents.on("context-menu", (_event, params) => {
    const { isEditable, selectionText } = params;
    if (!isEditable && !selectionText) return;
    const editing = isEditable
      ? ([{ role: "cut" }, { role: "copy" }, { role: "paste" }] as const)
      : ([{ role: "copy" }] as const);
    Menu.buildFromTemplate([...editing]).popup();
  });

  if (server) void created.loadURL(`${server.url}/`);
  else void created.loadFile(setupPage);
  return created;
}

function openPhoneWindow() {
  if (phoneWindow) {
    phoneWindow.show();
    phoneWindow.focus();
    return;
  }
  const created = new BrowserWindow({
    title: "Use Parley from your phone",
    width: 480,
    height: 720,
    minWidth: 420,
    minHeight: 480,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#1b1b1f" : "#fbfbf9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  phoneWindow = created;
  created.on("closed", () => {
    phoneWindow = undefined;
  });
  // The page is the app's own and opens nothing; its links go through the app.
  created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  created.webContents.on("will-navigate", (event) => event.preventDefault());
  void created.loadFile(phonePage);
}

/** Brings the window up, for a `parley://` link or a second launch. */
function focusWindow() {
  if (!app.isReady()) return;
  const target = window ?? createWindow();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

/**
 * Takes the app as far as it can go: Claude Code or Codex, then the server,
 * then the chat page. Stops at whichever needs the person, whose button calls
 * it again. Either program is enough to chat; setup offers Claude Code, the
 * one it can install.
 */
async function advance() {
  if (advancing || server) return;
  advancing = true;
  try {
    await takeNextSteps();
  } finally {
    advancing = false;
  }
}

async function takeNextSteps() {
  showSetup({ screen: "starting" });
  searchPath ||= await userPath();
  const [claude, codex] = await Promise.all([
    claudeStatus(searchPath),
    codexStatus(searchPath),
  ]);
  if (claude.state !== "ready" && codex.state !== "ready") {
    if (claude.state === "missing") return showSetup({ screen: "missing" });
    return showSetup({ screen: "signedOut" });
  }

  try {
    const ytDlpPath = await installYtDlp(path.join(resources, "bin"), dataDir);
    const running = await startServer({
      serverDir: path.join(resources, "server"),
      clientDir: path.join(resources, "client"),
      dataDir,
      // One that's there but signed out is still handed over: the server
      // leaves its models out and says why.
      claudePath: claude.state === "missing" ? undefined : claude.claudePath,
      codexPath: codex.state === "missing" ? undefined : codex.codexPath,
      ytDlpPath,
      searchPath,
    });
    server = running;
    phoneAccess.serverChanged(running.port);
    void running.exited.then(() => {
      server = undefined;
      phoneAccess.serverChanged(undefined);
      if (!quitting) {
        showServerFailure("Parley's server stopped unexpectedly", "");
      }
    });
    await window?.loadURL(`${running.url}/`);
    void updateYtDlp(ytDlpPath);
    void offerUpdate();
  } catch (error) {
    showServerFailure(
      "Parley couldn't start",
      error instanceof ServerStartError
        ? error.output
        : (error as Error).message,
    );
  }
}

function showServerFailure(title: string, output: string) {
  showSetup({
    screen: "error",
    title,
    output,
    logPath: path.join(dataDir, "logs", "server.log"),
  });
}

async function offerUpdate() {
  const release = await newerRelease(app.getVersion());
  if (!release) return;
  const options: MessageBoxOptions = {
    type: "info",
    message: `Parley ${release.version} is available`,
    detail: "You're on an older version. Download the new one to update.",
    buttons: ["Download", "Later"],
    defaultId: 0,
    cancelId: 1,
  };
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (response === 0 && isHttp(release.url)) {
    void shell.openExternal(release.url);
  }
}

/** Runs one setup step, showing what it prints, then tries again. */
async function runStep(title: string, program: string, args: string[]) {
  const lines: string[] = [];
  showSetup({ screen: "working", title, lines });
  const { child, finished } = runSetupStep(
    program,
    args,
    { ...process.env, PATH: searchPath },
    (line) => {
      lines.push(line);
      showSetup({ screen: "working", title, lines });
    },
  );
  setupStep = child;
  await finished;
  // A retry stopped it and has already moved on.
  if (setupStep !== child) return;
  setupStep = undefined;
  await advance();
}

/** Only the app's own pages may call these, not the chat page the server serves. */
function fromSetupPage(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url.startsWith("file:") ?? false;
}

function handleSetup(channel: string, listener: () => unknown) {
  ipcMain.handle(channel, (event) => {
    if (fromSetupPage(event)) return listener();
    return undefined;
  });
}

/** The chat page in the app's own window, which no phone gets: it has no preload. */
function fromChatPage(event: IpcMainInvokeEvent): boolean {
  return (
    server !== undefined &&
    event.sender === window?.webContents &&
    (event.senderFrame?.url.startsWith(`${server.url}/`) ?? false)
  );
}

function registerPhoneHandlers() {
  ipcMain.handle("phone:open", (event) => {
    if (fromChatPage(event)) openPhoneWindow();
  });
  ipcMain.handle("phone:summary", (event) =>
    fromChatPage(event) ? phoneSummary(phoneAccess.getState()) : "off",
  );
  handleSetup("phone:ready", () => phoneAccess.getState());
  handleSetup("phone:turnOn", () => phoneAccess.enable());
  handleSetup("phone:turnOff", () => phoneAccess.disable());
  handleSetup("phone:check", () => phoneAccess.check());
  handleSetup("phone:copyAddress", () => {
    const state = phoneAccess.getState();
    if (state.status === "on") clipboard.writeText(state.url);
  });
  handleSetup("phone:openDownload", () =>
    shell.openExternal(TAILSCALE_DOWNLOAD),
  );
  handleSetup("phone:openEnableHttps", () => {
    const state = phoneAccess.getState();
    if (state.status === "needsHttps") return shell.openExternal(state.url);
    return undefined;
  });
}

function registerSetupHandlers() {
  handleSetup("setup:ready", () => {
    window?.webContents.send("setup:state", setupState);
  });
  handleSetup("setup:install", () => {
    const { program, args } = installerCommand();
    return runStep("Installing Claude Code", program, args);
  });
  handleSetup("setup:signIn", async () => {
    const claude = await claudeStatus(searchPath);
    if (claude.state === "missing") return advance();
    return runStep("Signing in to Claude Code", claude.claudePath, [
      "auth",
      "login",
    ]);
  });
  handleSetup("setup:retry", () => {
    const running = setupStep;
    setupStep = undefined;
    running?.kill();
    return advance();
  });
  handleSetup("setup:openInstallDocs", () => shell.openExternal(INSTALL_DOCS));
  handleSetup("setup:showLogs", () =>
    shell.showItemInFolder(path.join(dataDir, "logs", "server.log")),
  );
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAsDefaultProtocolClient("parley");
  app.on("second-instance", focusWindow);
  app.on("open-url", (event) => {
    event.preventDefault();
    focusWindow();
  });

  void app.whenReady().then(() => {
    registerSetupHandlers();
    registerPhoneHandlers();
    createWindow();
    void advance();
    app.on("activate", focusWindow);
  });

  // On a Mac an app outlives its window, and a transcription carries on.
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // Waits for the server to finish up, then quits for real.
  app.on("before-quit", (event) => {
    phoneAccess.shutdown();
    if (!server) return;
    event.preventDefault();
    quitting = true;
    const running = server;
    server = undefined;
    void running.stop().finally(() => app.quit());
  });
}
