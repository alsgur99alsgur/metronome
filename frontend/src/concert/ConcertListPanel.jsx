import { useEffect, useState } from "react";

import { ConcertFileTable, folderRows } from "./ConcertFileTable";

export function ConcertFolderCreate({ apiBaseUrl, parentDirectory, onCreated, children }) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const create = async () => {
    const folderName = name.trim();
    if (!folderName) return;
    if (!/^[A-Za-z0-9_.-]+$/.test(folderName)) {
      setError("Folder name may contain only letters, numbers, '_', '-' or '.'.");
      return;
    }
    const directory = [parentDirectory, folderName].filter(Boolean).join("/");
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${apiBaseUrl}/deployments/directories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.detail || `Create folder failed (${response.status}).`);
      setName("");
      setIsEditing(false);
      onCreated?.(body?.directory || directory);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="concert-folder-create">
      {isEditing ? (
        <>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setIsEditing(false);
                setName("");
                setError("");
              }
            }}
            placeholder="folder_name"
          />
          <button disabled={busy} onClick={() => { setIsEditing(false); setName(""); setError(""); }}>Cancel</button>
          <button className="primary-button" disabled={busy || !name.trim()} onClick={create}>Create</button>
        </>
      ) : (
        <>
          <button onClick={() => setIsEditing(true)}>Add New Folder</button>
          {children}
        </>
      )}
      {error && <span className="dialog-error">{error}</span>}
    </div>
  );
}

export function ConcertDirectoryTree({ directories, directory, onChange, counts = {}, isDisabled = () => false }) {
  return (
    <div className="concert-list-folders" role="tree">
      {folderRows(directories).map(({ path, depth }) => (
        <button className={directory === path ? "active" : ""} key={path || "root"} disabled={isDisabled(path)} onClick={() => onChange(path)} role="treeitem" aria-selected={directory === path} style={{ paddingLeft: `${10 + depth * 18}px` }}>
          <span className="deploy-folder-marker">▾</span>
          <span>{path ? path.split("/").pop() : "concerts"}</span>
          {counts[path] !== undefined && <span className="concert-directory-count">{counts[path]}</span>}
        </button>
      ))}
    </div>
  );
}

export default function ConcertListPanel({ apiBaseUrl, fixedSource = "", directoryValue, onDirectoryChange, onDirectoriesChange, onOpen, openKinds, onClose, onSelect, selectedKey, onPromote, onRollback, onMove, canMove, onDelete, onDataChange, busy, refreshKey = 0 }) {
  const [directories, setDirectories] = useState([]);
  const [deployments, setDeployments] = useState({ concerts: [], rehearsals: [], backups: [] });
  const [directory, setDirectory] = useState("");
  const [source, setSource] = useState(fixedSource || "all");
  const [error, setError] = useState("");
  const activeDirectory = directoryValue ?? directory;
  const changeDirectory = (nextDirectory) => {
    setDirectory(nextDirectory);
    onDirectoryChange?.(nextDirectory);
  };

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(`${apiBaseUrl}/deployments/directories`).then((response) => response.ok ? response.json() : Promise.reject(new Error("Failed to load directories."))),
      fetch(`${apiBaseUrl}/deployments`).then((response) => response.ok ? response.json() : Promise.reject(new Error("Failed to load Concerts."))),
    ]).then(([directoryBody, deploymentBody]) => {
      if (!active) return;
      setDirectories(directoryBody.directories || []);
      onDirectoriesChange?.(directoryBody.directories || []);
      setDeployments({
        concerts: deploymentBody.concerts || [],
        rehearsals: deploymentBody.rehearsals || [],
        backups: deploymentBody.backups || [],
      });
      onDataChange?.(deploymentBody);
      if (directoryValue === undefined) setDirectory("");
      setError("");
    }).catch((nextError) => active && setError(nextError.message));
    return () => { active = false; };
  }, [apiBaseUrl, refreshKey, onDataChange]);

  const concerts = source === "all"
    ? [...deployments.concerts, ...deployments.rehearsals, ...deployments.backups]
    : deployments[source] || [];
  const directoryCounts = concerts.reduce((counts, item) => {
    const folder = item.name.includes("/") ? item.name.slice(0, item.name.lastIndexOf("/")) : "";
    counts[folder] = (counts[folder] || 0) + 1;
    return counts;
  }, Object.fromEntries(directories.map((path) => [path, 0])));

  return (
    <aside className="concert-list-panel">
      <div className="concert-list-title">
        <span>Concert List</span>
        {!fixedSource && (
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="all">All</option>
            <option value="concerts">Concerts</option>
            <option value="rehearsals">Rehearsals</option>
            <option value="backups">Backups</option>
          </select>
        )}
        {onClose && <button className="concert-list-close" onClick={onClose} title="Close Concert List">×</button>}
      </div>
      <div className="concert-list-browser">
        <ConcertDirectoryTree directories={directories} directory={activeDirectory} onChange={changeDirectory} counts={directoryCounts} />
        <div className="concert-list-files">
          {error ? <div className="dialog-error">{error}</div> : <ConcertFileTable concerts={concerts} directory={activeDirectory} onOpen={onOpen} openKinds={openKinds} onSelect={onSelect} selectedKey={selectedKey} onPromote={onPromote} onRollback={onRollback} onMove={onMove} canMove={canMove} onDelete={onDelete} busy={busy} />}
        </div>
      </div>
    </aside>
  );
}
