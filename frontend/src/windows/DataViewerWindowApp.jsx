import { useEffect } from "react";
import DataViewer from "../data-viewer/DataViewer.jsx";
import { useErrorDialog } from "../errors/ErrorDialog";
import "../data-viewer/dataViewer.css";

const payloads = window.opener?.__metronomeDataViewerPayloads;
const token = new URLSearchParams(window.location.search).get("dataViewer");
const initialPayload = token ? payloads?.get(token) : null;
if (token) payloads?.delete(token);

export default function DataViewerWindowApp() {
  const { showError } = useErrorDialog();
  document.documentElement.classList.add("data-viewer-document");
  useEffect(() => {
    if (!initialPayload) showError("Data viewer payload is unavailable.");
  }, [showError]);
  return initialPayload ? <DataViewer initialPayload={initialPayload} /> : null;
}
