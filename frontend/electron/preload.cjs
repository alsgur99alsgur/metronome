const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("metronomeElectron", {
  focusChildWindow(frameName) {
    ipcRenderer.send("focus-child-window", frameName);
  },
});
