import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./monacoSetup";
import App from "./App.jsx";
import DataViewer from "./data-viewer/DataViewer.jsx";
import "./data-viewer/dataViewer.css";

const dataViewerToken = new URLSearchParams(window.location.search).get(
  "dataViewer",
);
if (dataViewerToken) {
  document.documentElement.classList.add("data-viewer-document");
}
const dataViewerPayloads = window.opener?.__metronomeDataViewerPayloads;
const dataViewerPayload = dataViewerToken
  ? dataViewerPayloads?.get(dataViewerToken)
  : null;
if (dataViewerToken) dataViewerPayloads?.delete(dataViewerToken);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    {dataViewerToken ? (
      dataViewerPayload ? (
        <DataViewer initialPayload={dataViewerPayload} />
      ) : (
        <div className="fatal">Data viewer payload is unavailable.</div>
      )
    ) : (
      <App />
    )}
  </StrictMode>,
);
