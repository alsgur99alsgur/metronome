import { useEffect, useState } from "react";

import ConcertListPanel, { ConcertDirectoryTree, ConcertFolderCreate } from "./ConcertListPanel";
import { folderOf } from "./ConcertFileTable";

const responseError = async (response) => {
  const body = await response.json().catch(() => null);
  return typeof body?.detail === "string" ? body.detail : `Request failed (${response.status}).`;
};

export default function ConcertManagerDialog({ apiBaseUrl, serverName, onDeploymentChange, onClose }) {
  const [selected, setSelected] = useState(null);
  const [deployments, setDeployments] = useState({ concerts: [], rehearsals: [], backups: [] });
  const [directories, setDirectories] = useState([]);
  const [targetDirectory, setTargetDirectory] = useState("");
  const [showMove, setShowMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");
  const [selectedDirectory, setSelectedDirectory] = useState("");
  const [listDirectories, setListDirectories] = useState([]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      if (showMove) {
        setShowMove(false);
        return;
      }
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose, showMove]);

  const request = async (path, body, method = "POST", onSuccess) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await responseError(response));
      setSelected(null);
      setShowMove(false);
      onSuccess?.();
      setRefreshKey((value) => value + 1);
      onDeploymentChange?.();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  };

  const canMove = (item) => {
    if (item?.kind !== "concert") return false;
    const basename = item.name.split("/").pop();
    return !deployments.rehearsals.some(
      (rehearsal) => rehearsal.name.split("/").pop() === basename,
    );
  };
  const directoryHasFiles = Object.values(deployments)
    .flat()
    .some((item) => folderOf(item.name) === selectedDirectory);
  const directoryHasChildren = listDirectories.some(
    (item) => item.startsWith(`${selectedDirectory}/`),
  );
  const canDeleteDirectory = Boolean(
    selectedDirectory && !directoryHasFiles && !directoryHasChildren && !busy,
  );

  const openMove = async (item) => {
    const response = await fetch(`${apiBaseUrl}/deployments/directories`);
    if (!response.ok) { setError(await responseError(response)); return; }
    const body = await response.json();
    setSelected(item);
    setDirectories(body.directories || []);
    setTargetDirectory("");
    setShowMove(true);
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <section className="variable-dialog concert-manager" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header"><div><div className="eyebrow">{serverName}</div><h2>Stage Manager</h2></div></div>
        {error && <div className="dialog-error">{error}</div>}
        <ConcertListPanel
          apiBaseUrl={apiBaseUrl}
          fixedSource="all"
          refreshKey={refreshKey}
          directoryValue={selectedDirectory}
          onDirectoryChange={setSelectedDirectory}
          onDirectoriesChange={setListDirectories}
          busy={busy}
          selectedKey={selected ? `${selected.kind}:${selected.path}` : ""}
          onSelect={setSelected}
          onDataChange={setDeployments}
          onPromote={(item) => window.confirm(`Promote ${item.name}?`) && request("/deployments/promote", { name: item.name })}
          onRollback={(item) => window.confirm(`Rollback ${item.name} to ${item.backupVersion}?`) && request("/deployments/rollback", { backupPath: item.backupPath })}
          onMove={(item) => canMove(item) && openMove(item)}
          canMove={canMove}
          onDelete={(item) => window.confirm(`Delete ${item.path}?`) && request("/deployments", { kind: item.kind, path: item.path }, "DELETE")}
        />
        <ConcertFolderCreate
          apiBaseUrl={apiBaseUrl}
          parentDirectory={selectedDirectory}
          onCreated={(directory) => {
            setSelectedDirectory(directory);
            setRefreshKey((value) => value + 1);
            onDeploymentChange?.();
          }}
        >
          <button
            className="danger-button"
            disabled={!canDeleteDirectory}
            onClick={() => window.confirm(`Delete folder ${selectedDirectory}?`) && request(
              "/deployments/directories",
              { directory: selectedDirectory },
              "DELETE",
              () => setSelectedDirectory(""),
            )}
          >
            Delete Folder
          </button>
        </ConcertFolderCreate>
      </section>
      {showMove && (
        <div className="modal-backdrop" onClick={(event) => { event.stopPropagation(); setShowMove(false); }}>
          <section className="save-dialog move-folder-dialog" onClick={(event) => event.stopPropagation()}>
            <h3>Move Folder</h3>
            <ConcertDirectoryTree directories={directories} directory={targetDirectory} onChange={setTargetDirectory} />
            <div className="save-dialog-actions"><button onClick={() => setShowMove(false)}>Cancel</button><button className="primary-button" disabled={busy} onClick={() => request("/deployments/move", { name: selected.name, directory: targetDirectory })}>Move</button></div>
          </section>
        </div>
      )}
    </div>
  );
}
