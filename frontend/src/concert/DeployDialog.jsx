import { useEffect, useState } from "react";

import { ConcertFileTable, folderOf } from "./ConcertFileTable";
import { ConcertDirectoryTree, ConcertFolderCreate } from "./ConcertListPanel";

const versionPattern = /^[A-Za-z0-9.-]+$/;

export default function DeployDialog({ target, sourceName, apiBaseUrl, onDeploy, onDirectoryCreated, onClose }) {
  const [version, setVersion] = useState("");
  const [directories, setDirectories] = useState([]);
  const [concerts, setConcerts] = useState([]);
  const [productionDirectory, setProductionDirectory] = useState(null);
  const [directory, setDirectory] = useState(folderOf(sourceName));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      if (warning) {
        setWarning("");
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, warning]);

  const loadDirectories = async (preferredDirectory = directory) => {
    const [directoryResponse, deploymentResponse] = await Promise.all([
      fetch(`${apiBaseUrl}/deployments/directories`),
      fetch(`${apiBaseUrl}/deployments`),
    ]);
    const [directoryBody, deploymentBody] = await Promise.all([
      directoryResponse.json().catch(() => null),
      deploymentResponse.json().catch(() => null),
    ]);
    if (!directoryResponse.ok) throw new Error(directoryBody?.detail || `Load directories failed (${directoryResponse.status}).`);
    if (!deploymentResponse.ok) throw new Error(deploymentBody?.detail || `Load deployments failed (${deploymentResponse.status}).`);
    const nextDirectories = directoryBody.directories || [];
    const baseName = sourceName.split("/").pop();
    const production = (deploymentBody.concerts || []).find((item) => item.name.split("/").pop() === baseName);
    const lockedDirectory = production ? folderOf(production.name) : null;
    setDirectories(nextDirectories);
    setConcerts(deploymentBody.concerts || []);
    setProductionDirectory(lockedDirectory);
    setDirectory(lockedDirectory ?? (nextDirectories.includes(preferredDirectory) ? preferredDirectory : ""));
  };

  useEffect(() => { loadDirectories().catch((nextError) => setError(nextError.message)); }, []);

  const deploy = async (allowMismatch = false) => {
    if (!versionPattern.test(version)) {
      setError("Version may contain only letters, numbers, '.', and '-'.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await onDeploy(version, directory, allowMismatch);
      setMessage(`Rehearsal created on ${result.servers?.join(", ") || target}.`);
    } catch (nextError) {
      if (nextError?.name === "AbortError") return;
      if (nextError?.retryableMismatch && !allowMismatch) {
        setWarning(nextError.message);
      } else {
        setError(nextError.message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <section className="variable-dialog concert-manager deploy-dialog rehearsal-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div><div className="eyebrow">{target}</div><h3>Rehearsal</h3></div>
        </div>
        <div className="concert-list-panel rehearsal-concert-list">
          <div className="concert-list-title"><span>Concert List</span></div>
          <div className="concert-list-browser">
            <ConcertDirectoryTree
              directories={directories}
              directory={directory}
              onChange={setDirectory}
              isDisabled={(item) => productionDirectory !== null && productionDirectory !== item}
            />
            <div className="concert-list-files">
              <ConcertFileTable concerts={concerts} directory={directory} />
            </div>
          </div>
        </div>
        <ConcertFolderCreate
          apiBaseUrl={apiBaseUrl}
          parentDirectory={directory}
          onCreated={(createdDirectory) => {
            void loadDirectories(createdDirectory);
            onDirectoryCreated?.();
          }}
        />
        <div className="rehearsal-settings">
          <label className="field-label">
            Selected Directory
            <input value={directory || "concerts"} readOnly />
          </label>
          <label className="field-label">
            Version
            <input autoFocus value={version} onChange={(event) => setVersion(event.target.value)} />
          </label>
          {error && <div className="dialog-error">{error}</div>}
          {message && <div className="deploy-success">{message}</div>}
        </div>
        <div className="save-dialog-actions">
          <button disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || Boolean(message)} onClick={() => deploy(false)}>{busy ? "Creating Rehearsal..." : "Rehearsal"}</button>
        </div>
      </section>
      {warning && (
        <div className="modal-backdrop" onClick={(event) => { event.stopPropagation(); setWarning(""); }}>
          <section className="save-dialog rehearsal-warning-dialog" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h3>Rehearsal Warning</h3>
            <p>{warning}</p>
            <p>Do you want to continue with the Rehearsal?</p>
            <div className="save-dialog-actions">
              <button onClick={() => setWarning("")}>No</button>
              <button className="warning-button" onClick={() => { setWarning(""); void deploy(true); }}>Yes</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
