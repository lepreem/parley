import { homedir } from "node:os";
import path from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from "electron";
import { claudeStatus, installerCommand, runSetupStep } from "./claudeCode";
import { ServerStartError, startServer, type RunningServer } from "./server";
import type { SetupState } from "./setupState";
import { userPath } from "./shellPath";
import { newerRelease } from "./updates";
import { installYtDlp, updateYtDlp } from "./ytDlp";

const INSTALL_DOCS = "https://code.claude.com/docs/en/setup";

/** Where the app keeps its files, the same place a server started by hand does. */
const dataDir = process.env.DATA_DIR ?? path.join(homedir(), ".parley");

/** What the build put next to the app: the server, the client and yt-dlp. */
const resources = app.isPackaged
  ? process.resourcesPath
  : path.join(app.getAppPath(), "build");

const setupPage = path.join(app.getAppPath(), "static", "setup.html");

let window: BrowserWindow | undefined;
let server: RunningServer | undefined;
let searchPath = "";
let setupState: SetupState = { screen: "starting" };
/** The setup program running now, which a retry stops. */
let setupStep: { kill(): boolean } | undefined;
let quitting = false;
/** Stops a second click starting a second server while the first starts. */
let advancing = false;

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
  // Nothing the app does needs the camera, location or the like.
  created.webContents.session.setPermissionRequestHandler(
    (_contents, permission, callback) =>
      callback(
        ["clipboard-sanitized-write", "fullscreen"].includes(permission),
      ),
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

/** Brings the window up, for a `parley://` link or a second launch. */
function focusWindow() {
  if (!app.isReady()) return;
  const target = window ?? createWindow();
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

/**
 * Takes the app as far as it can go: Claude Code, then the server, then the
 * chat page. Stops at whichever needs the person, whose button calls it again.
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
  const claude = await claudeStatus(searchPath);
  if (claude.state === "missing") return showSetup({ screen: "missing" });
  if (claude.state === "signedOut") return showSetup({ screen: "signedOut" });

  try {
    const ytDlpPath = await installYtDlp(path.join(resources, "bin"), dataDir);
    const running = await startServer({
      serverDir: path.join(resources, "server"),
      clientDir: path.join(resources, "client"),
      dataDir,
      claudePath: claude.claudePath,
      ytDlpPath,
      searchPath,
    });
    server = running;
    void running.exited.then(() => {
      server = undefined;
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

/** Only the setup page may call these, not the chat page the server serves. */
function fromSetupPage(event: IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url.startsWith("file:") ?? false;
}

function handleSetup(channel: string, listener: () => unknown) {
  ipcMain.handle(channel, (event) => {
    if (fromSetupPage(event)) return listener();
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
    if (!server) return;
    event.preventDefault();
    quitting = true;
    const running = server;
    server = undefined;
    void running.stop().finally(() => app.quit());
  });
}
