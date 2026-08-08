const { app, BrowserWindow, dialog } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let backendProcess = null;

function installDirectory() {
  return app.isPackaged ? path.dirname(app.getPath("exe")) : path.resolve(__dirname, "../..");
}

function backendExecutable() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "backend", "metronome-backend.exe");
  }
  return path.resolve(__dirname, "../../backend/dist/metronome-backend.exe");
}

function startBackend() {
  const executable = backendExecutable();
  if (!fs.existsSync(executable)) {
    throw new Error(`Backend executable not found: ${executable}`);
  }

  backendProcess = spawn(executable, [], {
    cwd: installDirectory(),
    env: {
      ...process.env,
      METRONOME_DATA_DIR: installDirectory(),
    },
    windowsHide: true,
    stdio: "ignore",
  });
  backendProcess.once("exit", () => {
    backendProcess = null;
  });
}

async function waitForBackend(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:8000/health");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Backend did not become ready within 30 seconds.");
}

async function createWindow() {
  startBackend();
  await waitForBackend();

  const window = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1200,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await window.loadFile(path.join(__dirname, "../dist/index.html"));
  window.once("ready-to-show", () => window.show());
}

function stopBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox("Metronome startup failed", error.message);
  app.quit();
});

app.on("before-quit", stopBackend);
app.on("window-all-closed", () => app.quit());
