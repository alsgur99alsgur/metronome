const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");

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
    },
  });
  window.setMenu(null);
  window.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: { autoHideMenuBar: true },
  }));
  window.webContents.on("did-create-window", (childWindow) => {
    childWindow.setMenu(null);
    childWindow.setAutoHideMenuBar(true);
  });
  const indexPath = adminApp
    ? path.join(process.resourcesPath, "admin-dist", "index.html")
    : path.join(__dirname, "../dist/index.html");
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
  window.once("ready-to-show", () => window.show());
}

app.whenReady().then(createWindow).catch(async (error) => {
  dialog.showErrorBox("Metronome startup failed", error.message);
  app.quit();
});

app.on("window-all-closed", () => app.quit());
