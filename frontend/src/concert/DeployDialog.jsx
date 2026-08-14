import { useCallback, useEffect, useRef, useState } from "react";

import { ConcertFileTable } from "./ConcertFileTable";
import { folderOf } from "./concertPathUtils";
import { ConcertDirectoryTree, ConcertFolderCreate } from "./ConcertListPanel";
import { useErrorDialog } from "../errors/ErrorDialog";

const versionPattern = /^[A-Za-z0-9.-]+$/;

export default function DeployDialog({ target, sourceName, apiBaseUrl, onDeploy, onDirectoryCreated, onClose }) {
  const { showError } = useErrorDialog();
  const [version, setVersion] = useState("");
  const [directories, setDirectories] = useState([]);
  const [deployments, setDeployments] = useState([]);
  const [lockedDirectory, setLockedDirectory] = useState(null);
  const [hasRehearsal, setHasRehearsal] = useState(false);
  const [directory, setDirectory] = useState(folderOf(sourceName));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [notice, setNotice] = useState("");
  const attemptCommitId = useRef(null);

  useEffect(() => {
    if (error) showError(error);
  }, [error, showError]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      if (notice) {
        setNotice("");
        return;
      }
      if (warning) {
        setWarning("");
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, notice, onClose, warning]);

  const loadDirectories = useCallback(async (preferredDirectory = folderOf(sourceName)) => {
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
    const allDeployments = [
      ...(deploymentBody.playings || []),
      ...(deploymentBody.rehearsals || []),
      ...(deploymentBody.backups || []),
    ];
    const rehearsalExists = (deploymentBody.rehearsals || []).some(
      (item) => item.name.split("/").pop() === baseName,
    );
    const sameName = allDeployments.find((item) => item.name.split("/").pop() === baseName);
    const nextLockedDirectory = sameName ? folderOf(sameName.name) : null;
    setDirectories(nextDirectories);
    setDeployments(allDeployments);
    setLockedDirectory(nextLockedDirectory);
    setHasRehearsal(rehearsalExists);
    setDirectory(nextLockedDirectory ?? (nextDirectories.includes(preferredDirectory) ? preferredDirectory : ""));
  }, [apiBaseUrl, sourceName]);

  useEffect(() => {
    loadDirectories().catch((nextError) => setError(nextError.message));
  }, [loadDirectories]);

  const deploy = async (allowMismatch = false) => {
    if (hasRehearsal) return;
    const nextVersion = version.trim();
    if (!nextVersion) {
      setNotice("Version is required.");
      return;
    }
    if (!versionPattern.test(nextVersion)) {
      setError("Version may contain only letters, numbers, '.', and '-'.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (!attemptCommitId.current) attemptCommitId.current = crypto.randomUUID();
      await onDeploy(nextVersion, directory, allowMismatch, attemptCommitId.current);
      attemptCommitId.current = null;
      onClose();
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
              isDisabled={(item) => lockedDirectory !== null && lockedDirectory !== item}
            />
            <div className="concert-list-files">
              <ConcertFileTable concerts={deployments} directory={directory} />
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
        </div>
        <div className="save-dialog-actions">
          <button disabled={busy} onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || hasRehearsal} onClick={() => deploy(false)}>{busy ? "Creating Rehearsal..." : "Rehearsal"}</button>
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
      {notice && (
        <div className="modal-backdrop" onClick={(event) => { event.stopPropagation(); setNotice(""); }}>
          <section className="save-dialog rehearsal-warning-dialog" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h3>Rehearsal</h3>
            <p>{notice}</p>
            <div className="save-dialog-actions">
              <button className="primary-button" onClick={() => setNotice("")}>OK</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
