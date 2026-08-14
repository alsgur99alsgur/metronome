import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ErrorDialogProvider } from "./errors/ErrorDialog.jsx";

const dataViewerToken = new URLSearchParams(window.location.search).get("dataViewer");
const windowModule = dataViewerToken
  ? import("./windows/DataViewerWindowApp.jsx")
  : import("./windows/MainWindow.jsx");

windowModule.then(({ default: WindowApp }) => {
  createRoot(document.getElementById("root")).render(
    <StrictMode>
      <ErrorDialogProvider>
        <WindowApp />
      </ErrorDialogProvider>
    </StrictMode>,
  );
});
