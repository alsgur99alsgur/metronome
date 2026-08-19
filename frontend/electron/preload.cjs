const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("metronomeElectron", {
  focusChildWindow(frameName) {
    ipcRenderer.send("focus-child-window", frameName);
  },
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  openConcertFile() {
    return ipcRenderer.invoke("open-concert-file");
  },
  selectConcertSavePath(suggestedName) {
    return ipcRenderer.invoke("select-concert-save-path", suggestedName);
  },
  writeConcertFile(filePath, content) {
    return ipcRenderer.invoke("write-concert-file", filePath, content);
  },
});
