const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

let backendProcess = null;
let backendExitError = null;
const backendToken = crypto.randomUUID();

function isAdminApp() {
  return process.argv.includes("--admin");
}

app.setPath(
  "userData",
  path.join(
    path.dirname(app.getPath("exe")),
    isAdminApp() ? "electron-admin-data" : "electron-data",
  ),
);

function installDirectory() {
  return app.isPackaged ? path.dirname(app.getPath("exe")) : path.resolve(__dirname, "../..");
}

function backendExecutable() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "backend", "metronome-backend.exe");
  }
  return path.resolve(__dirname, "../../backend/dist/metronome-backend.exe");
}

function localServerPort() {
  const serversPath = path.join(installDirectory(), "servers.json");
  if (!fs.existsSync(serversPath)) return 8000;

  const servers = JSON.parse(fs.readFileSync(serversPath, "utf8"));
  if (!Array.isArray(servers)) {
    throw new Error("servers.json must contain an array.");
  }
  const localServers = servers.filter((server) => server?.name === "Local");
  if (localServers.length !== 1) {
    throw new Error("servers.json must contain exactly one Local server.");
  }
  const port = localServers[0].port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Local server port must be an integer from 1 to 65535.");
  }
  return port;
}

function startBackend() {
  const executable = backendExecutable();
  if (!fs.existsSync(executable)) {
    throw new Error(`Backend executable not found: ${executable}`);
  }

  backendExitError = null;
  backendProcess = spawn(executable, [], {
    cwd: installDirectory(),
    env: {
      ...process.env,
      METRONOME_DATA_DIR: installDirectory(),
      METRONOME_SHUTDOWN_TOKEN: backendToken,
    },
    windowsHide: true,
    stdio: "ignore",
  });
  backendProcess.once("exit", (code) => {
    if (code !== 0) backendExitError = `Backend exited with code ${code}.`;
    backendProcess = null;
  });
}

async function waitForBackend(port, adminApp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!adminApp && backendExitError) throw new Error(backendExitError);
    try {
      const endpoint = adminApp ? "/health" : "/desktop/health";
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
        headers: adminApp ? {} : { "X-Metronome-Token": backendToken },
      });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Backend did not become ready within 30 seconds.");
}

async function createWindow() {
  const adminApp = isAdminApp();
  const localPort = localServerPort();
  if (!adminApp) startBackend();
  await waitForBackend(localPort, adminApp);

  const window = new BrowserWindow({
    width: adminApp ? 1440 : 1600,
    height: adminApp ? 900 : 1000,
    minWidth: adminApp ? 1000 : 1200,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const indexPath = adminApp
    ? path.join(process.resourcesPath, "admin-dist", "index.html")
    : path.join(__dirname, "../dist/index.html");
  await window.loadFile(indexPath, {
    query: { localPort: String(localPort) },
  });
  if (!adminApp) {
    window.webContents.on("will-prevent-unload", (event) => {
      const choice = dialog.showMessageBoxSync(window, {
        type: "warning",
        buttons: ["Exit", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        title: "Unsaved changes",
        message: "There are unsaved Concert changes.",
        detail: "Exit without saving the changes?",
        noLink: true,
      });
      if (choice === 0) {
        event.preventDefault();
      }
    });
  }
  window.once("ready-to-show", () => window.show());
}

function waitForBackendExit(process, timeoutMs) {
  return new Promise((resolve) => {
    if (!process || process.exitCode !== null) return resolve(true);
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    process.once("exit", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function stopBackend() {
  const process = backendProcess;
  if (!process) return;

  try {
    await fetch(`http://127.0.0.1:${localServerPort()}/desktop/shutdown`, {
      method: "POST",
      headers: { "X-Metronome-Token": backendToken },
    });
  } catch {}

  if (await waitForBackendExit(process, 3000)) return;
  if (global.process.platform === "win32") {
    const killer = spawn(
      "taskkill",
      ["/pid", String(process.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    );
    await new Promise((resolve) => killer.once("exit", resolve));
  } else {
    process.kill("SIGKILL");
  }
}

app.whenReady().then(createWindow).catch(async (error) => {
  const detail = isAdminApp()
    ? `${error.message}\n\nStart metronome.exe first.`
    : error.message;
  dialog.showErrorBox("Metronome startup failed", detail);
  if (!isAdminApp()) await stopBackend();
  app.quit();
});

app.on("window-all-closed", async () => {
  if (!isAdminApp()) await stopBackend();
  app.quit();
});
