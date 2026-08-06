import { useCallback, useEffect, useState } from "react";
import { openDataWindow } from "./DataViewerWindow";

const responseError = async (response) => {
  const body = await response.json().catch(() => null);
  return body?.detail || `Request failed (${response.status}).`;
};

const emptyDataframe = {
  kind: "dataframe",
  rows: 0,
  columns: [],
  dtypes: {},
  data: [],
  dataLimit: 1000,
  truncated: false,
};

export default function StageResourcesDialog({ apiBaseUrl, serverName, onClose }) {
  const [resources, setResources] = useState([]);
  const [kind, setKind] = useState("cache");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleteName, setDeleteName] = useState("");
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const response = await fetch(`${apiBaseUrl}/stage-resources`);
    if (!response.ok) throw new Error(await response.text());
    setResources((await response.json()).resources || []);
  }, [apiBaseUrl]);
  useEffect(() => { load().catch((nextError) => setError(nextError.message)); }, [load]);
  const create = async () => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/stage-resources`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, name }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      setName(""); await load();
    } catch (nextError) { setNotice(nextError.message); } finally { setBusy(false); }
  };
  const remove = async (resource) => {
    setBusy(true); setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/stage-resources/${encodeURIComponent(resource.kind)}/${encodeURIComponent(resource.name)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(await response.text());
      setPendingDelete(null); setDeleteName(""); await load();
    } catch (nextError) { setError(nextError.message); } finally { setBusy(false); }
  };
  const view = async (resource) => {
    const viewer = window.open("", `stage-resource-${resource.kind}-${resource.name}`, "popup=yes,width=1240,height=820,menubar=no,toolbar=no,location=no");
    if (!viewer) { setError("Popup was blocked. Allow popups to view Stage resources."); return; }
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/stage-resources/${encodeURIComponent(resource.kind)}/${encodeURIComponent(resource.name)}/data`);
      if (!response.ok && response.status !== 404) throw new Error(await responseError(response));
      openDataWindow(
        { id: `stage-${resource.kind}-${resource.name}`, data: { name: resource.name } },
        { result: response.ok ? await response.json() : emptyDataframe },
        viewer,
      );
    } catch (nextError) { viewer.close(); setError(nextError.message); }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section className="variable-dialog stage-resources-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-header"><div><div className="eyebrow">{serverName}</div><h2>Stage Resources</h2></div><button onClick={onClose}>Close</button></div>
        <div className="stage-resource-create">
          <select value={kind} onChange={(event) => setKind(event.target.value)}><option value="cache">Cache</option><option value="file">File</option></select>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="resource_name" />
          <button disabled={busy || !name.trim()} onClick={create}>Create</button>
        </div>
        {error && <div className="dialog-error">{error}</div>}
        <div className="stage-resource-list">
          {resources.map((resource) => <div className="stage-resource-row" key={`${resource.kind}:${resource.name}`}><span>{resource.kind === "cache" ? "Cache" : "File"}</span><strong>{resource.name}</strong><button disabled={busy} onClick={() => view(resource)}>View</button><button className="danger-button" disabled={busy} onClick={() => { setPendingDelete(resource); setDeleteName(""); }}>Delete</button></div>)}
          {!resources.length && <p className="muted">No Stage resources.</p>}
        </div>
      </section>
      {pendingDelete && (
        <div className="modal-backdrop" onClick={(event) => { event.stopPropagation(); setPendingDelete(null); }}>
          <section className="save-dialog resource-delete-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h3>Delete Stage Resource</h3>
            <p><strong>{pendingDelete.name}</strong> will be permanently deleted. Enter the resource name to confirm.</p>
            <input autoFocus value={deleteName} onChange={(event) => setDeleteName(event.target.value)} placeholder={pendingDelete.name} />
            <div className="save-dialog-actions">
              <button onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className="danger-button" disabled={busy || deleteName !== pendingDelete.name} onClick={() => remove(pendingDelete)}>Delete</button>
            </div>
          </section>
        </div>
      )}
      {notice && (
        <div className="modal-backdrop" onClick={(event) => { event.stopPropagation(); setNotice(""); }}>
          <section className="save-dialog" role="alertdialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <h3>Cannot Create Resource</h3>
            <p>{notice}</p>
            <div className="save-dialog-actions">
              <button className="primary-button" autoFocus onClick={() => setNotice("")}>OK</button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
