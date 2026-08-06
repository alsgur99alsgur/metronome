import { useState } from "react";

import ConcertListPanel, { ConcertDirectoryTree } from "./ConcertListPanel";

const responseError = async (response) => {
  const body = await response.json().catch(() => null);
  return typeof body?.detail === "string" ? body.detail : `Request failed (${response.status}).`;
};

export default function ConcertManagerDialog({ apiBaseUrl, serverName, onClose }) {
  const [selected, setSelected] = useState(null);
  const [deployments, setDeployments] = useState({ concerts: [], rehearsals: [], backups: [] });
  const [directories, setDirectories] = useState([]);
  const [targetDirectory, setTargetDirectory] = useState("");
  const [showMove, setShowMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState("");

  const request = async (path, body, method = "POST") => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await responseError(response));
      setSelected(null);
      setShowMove(false);
      setRefreshKey((value) => value + 1);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  };

  const selectedBasename = selected?.name.split("/").pop();
  const hasRehearsal = Boolean(selectedBasename && deployments.rehearsals.some((item) => item.name.split("/").pop() === selectedBasename));
  const canMove = selected?.kind === "concert" && !hasRehearsal;

  const openMove = async () => {
    const response = await fetch(`${apiBaseUrl}/deployments/directories`);
    if (!response.ok) { setError(await responseError(response)); return; }
    const body = await response.json();
    setDirectories(body.directories || []);
    setTargetDirectory("");
    setShowMove(true);
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <section className="variable-dialog concert-manager" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header"><div><div className="eyebrow">{serverName}</div><h2>Stage Manager</h2></div><div className="concert-manager-actions"><button disabled={!canMove || busy} onClick={openMove}>Move Folder</button><button className="danger-button" disabled={!selected || busy} onClick={() => window.confirm(`Delete ${selected.path}?`) && request("/deployments", { kind: selected.kind, path: selected.path }, "DELETE")}>Delete</button><button disabled={busy} onClick={onClose}>Close</button></div></div>
        {error && <div className="dialog-error">{error}</div>}
        <ConcertListPanel
          apiBaseUrl={apiBaseUrl}
          refreshKey={refreshKey}
          busy={busy}
          selectedKey={selected ? `${selected.kind}:${selected.path}` : ""}
          onSelect={setSelected}
          onDataChange={setDeployments}
          onPromote={(item) => window.confirm(`Promote ${item.name}?`) && request("/deployments/promote", { name: item.name })}
          onRollback={(item) => window.confirm(`Rollback ${item.name} to ${item.backupVersion}?`) && request("/deployments/rollback", { backupPath: item.backupPath })}
        />
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
