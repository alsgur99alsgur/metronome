import { useEffect, useState } from "react";

import { ConcertFileTable, folderOf, folderRows } from "./ConcertFileTable";

const versionPattern = /^[A-Za-z0-9.-]+$/;

export default function DeployDialog({ target, sourceName, apiBaseUrl, onDeploy, onClose }) {
  const [version, setVersion] = useState("");
  const [directories, setDirectories] = useState([]);
  const [concerts, setConcerts] = useState([]);
  const [productionDirectory, setProductionDirectory] = useState(null);
  const [directory, setDirectory] = useState(folderOf(sourceName));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

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

  const deploy = async () => {
    if (!versionPattern.test(version)) {
      setError("Version may contain only letters, numbers, '.', and '-'.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const baseName = sourceName.split("/").pop();
      const production = concerts.find((item) => item.name.split("/").pop() === baseName);
      const versionMismatch = production && production.version !== version;
      if (versionMismatch && !window.confirm(`Production version is ${production.version}. Deploy version ${version}?`)) return;
      const result = await onDeploy(version, directory, Boolean(versionMismatch));
      setMessage(`Deployed to ${result.servers?.join(", ") || target}.`);
    } catch (nextError) {
      if (nextError?.name !== "AbortError") setError(nextError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <section className="save-dialog deploy-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <h3>Deploy to {target}</h3>
        <div className="deploy-dialog-grid">
          <aside className="deploy-folder-panel">
            <div className="deploy-folder-title"><span>Concerts</span></div>
            <div className="deploy-folder-tree" role="tree">
              {folderRows(directories).map(({ path: item, depth }) => {
                const label = item ? item.split("/").pop() : "concerts";
                return (
                  <button
                    className={directory === item ? "active" : ""}
                    key={item || "root"}
                    disabled={productionDirectory !== null && productionDirectory !== item}
                    onClick={() => setDirectory(item)}
                    role="treeitem"
                    aria-selected={directory === item}
                    style={{ paddingLeft: `${12 + depth * 20}px` }}
                  >
                    <span className="deploy-folder-marker">▾</span>
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </aside>
          <div className="deploy-settings">
            <div className="deploy-concert-list">
              <div className="deploy-settings-title">Deployed Concerts</div>
              <ConcertFileTable concerts={concerts} directory={directory} />
            </div>
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
        </div>
        <div className="save-dialog-actions">
          <button disabled={busy} onClick={onClose}>Close</button>
          <button className="primary-button" disabled={busy || Boolean(message)} onClick={deploy}>{busy ? "Deploying..." : "Deploy"}</button>
        </div>
      </section>
    </div>
  );
}
