const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");

const childWindows = new Map();

function bringWindowToFront(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  if (targetWindow.isMinimized()) targetWindow.restore();
  if (!targetWindow.isVisible()) targetWindow.show();
  app.focus({ steal: true });
  targetWindow.moveTop();
  targetWindow.focus();
}

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

async function createWindow() {
  const adminApp = isAdminApp();

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
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(({ frameName }) => {
    if (frameName?.startsWith("data-viewer-")) {
      const existingWindow = childWindows.get(frameName);
      if (existingWindow && !existingWindow.isDestroyed()) {
        setImmediate(() => bringWindowToFront(existingWindow));
      }
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: { autoHideMenuBar: true },
    };
  });
  window.webContents.on("did-create-window", (childWindow, details) => {
    childWindow.setMenu(null);
    childWindow.setAutoHideMenuBar(true);
    if (details.frameName?.startsWith("data-viewer-")) {
      childWindows.set(details.frameName, childWindow);
      childWindow.on("closed", () => {
        if (childWindows.get(details.frameName) === childWindow) childWindows.delete(details.frameName);
      });
    }
  });
  ipcMain.on("focus-child-window", (event, frameName) => {
    if (event.sender !== window.webContents || typeof frameName !== "string" || !frameName.startsWith("data-viewer-")) return;
    bringWindowToFront(childWindows.get(frameName));
  });
  const indexPath = adminApp
    ? path.join(process.resourcesPath, "admin-dist", "index.html")
    : path.join(__dirname, "../dist/index.html");
  window.once("ready-to-show", () => window.show());
  await window.loadFile(indexPath);
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
}

app.whenReady().then(createWindow).catch(async (error) => {
  dialog.showErrorBox("Metronome startup failed", error.message);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
