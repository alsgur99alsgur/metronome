const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const childWindows = new Map();
const writableConcertPaths = new Set();
const adminApp = process.argv.includes("--admin");
const devMode = process.argv.includes("--dev");

function bringWindowToFront(targetWindow) {
  if (!targetWindow || targetWindow.isDestroyed()) return;
  if (targetWindow.isMinimized()) targetWindow.restore();
  if (!targetWindow.isVisible()) targetWindow.show();
  app.focus({ steal: true });
  targetWindow.moveTop();
  targetWindow.focus();
}

app.setPath(
  "userData",
  path.join(
    path.dirname(app.getPath("exe")),
    adminApp ? "electron-admin-data" : "electron-data",
  ),
);

async function createWindow() {
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
  ipcMain.handle("open-concert-file", async (event) => {
    if (event.sender !== window.webContents) return null;
    const result = await dialog.showOpenDialog(window, {
      properties: ["openFile"],
      filters: [{ name: "Concert", extensions: ["concert"] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const filePath = path.resolve(result.filePaths[0]);
    writableConcertPaths.add(filePath);
    return {
      path: filePath,
      name: path.basename(filePath),
      content: await fs.readFile(filePath, "utf8"),
    };
  });
  ipcMain.handle("select-concert-save-path", async (event, suggestedName) => {
    if (event.sender !== window.webContents) return null;
    const result = await dialog.showSaveDialog(window, {
      defaultPath: typeof suggestedName === "string" ? suggestedName : "concert.concert",
      filters: [{ name: "Concert", extensions: ["concert"] }],
    });
    if (result.canceled || !result.filePath) return null;
    const filePath = path.resolve(result.filePath);
    writableConcertPaths.add(filePath);
    return { path: filePath, name: path.basename(filePath) };
  });
  ipcMain.handle("write-concert-file", async (event, filePath, content) => {
    if (event.sender !== window.webContents) return false;
    const resolvedPath = path.resolve(String(filePath || ""));
    if (!writableConcertPaths.has(resolvedPath)) {
      throw new Error("Concert file path was not selected by this application.");
    }
    if (typeof content !== "string") {
      throw new TypeError("Concert file content must be a string.");
    }
    const temporaryPath = path.join(
      path.dirname(resolvedPath),
      `.${path.basename(resolvedPath)}.${randomUUID()}.tmp`,
    );
    try {
      await fs.writeFile(temporaryPath, content, "utf8");
      await fs.rename(temporaryPath, resolvedPath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
    return true;
  });
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
        if (childWindows.get(details.frameName) === childWindow)
          childWindows.delete(details.frameName);
      });
    }
  });
  ipcMain.on("focus-child-window", (event, frameName) => {
    if (
      event.sender !== window.webContents ||
      typeof frameName !== "string" ||
      !frameName.startsWith("data-viewer-")
    )
      return;
    bringWindowToFront(childWindows.get(frameName));
  });
  const indexPath = adminApp
    ? devMode
      ? path.join(__dirname, "../../admin-frontend/dist/index.html")
      : path.join(process.resourcesPath, "admin-dist", "index.html")
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

app
  .whenReady()
  .then(createWindow)
  .catch(async (error) => {
    dialog.showErrorBox("Metronome startup failed", error.message);
    app.quit();
  });

app.on("window-all-closed", () => app.quit());
