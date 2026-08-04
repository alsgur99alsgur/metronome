import { useEffect, useState } from "react";

import { ConcertFileTable, folderRows } from "./ConcertFileTable";

export function ConcertDirectoryTree({ directories, directory, onChange, counts = {} }) {
  return (
    <div className="concert-list-folders" role="tree">
      {folderRows(directories).map(({ path, depth }) => (
        <button className={directory === path ? "active" : ""} key={path || "root"} onClick={() => onChange(path)} role="treeitem" aria-selected={directory === path} style={{ paddingLeft: `${10 + depth * 18}px` }}>
          <span className="deploy-folder-marker">▾</span>
          <span>{path ? path.split("/").pop() : "concerts"}</span>
          {counts[path] !== undefined && <span className="concert-directory-count">{counts[path]}</span>}
        </button>
      ))}
    </div>
  );
}

export default function ConcertListPanel({ apiBaseUrl, fixedSource = "", onOpen, openKinds, onClose, onSelect, selectedKey, onPromote, onRollback, onDataChange, busy, refreshKey = 0 }) {
  const [directories, setDirectories] = useState([]);
  const [deployments, setDeployments] = useState({ concerts: [], rehearsals: [], backups: [] });
  const [directory, setDirectory] = useState("");
  const [source, setSource] = useState(fixedSource || "all");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch(`${apiBaseUrl}/deployments/directories`).then((response) => response.ok ? response.json() : Promise.reject(new Error("Failed to load directories."))),
      fetch(`${apiBaseUrl}/deployments`).then((response) => response.ok ? response.json() : Promise.reject(new Error("Failed to load Concerts."))),
    ]).then(([directoryBody, deploymentBody]) => {
      if (!active) return;
      setDirectories(directoryBody.directories || []);
      setDeployments({
        concerts: deploymentBody.concerts || [],
        rehearsals: deploymentBody.rehearsals || [],
        backups: deploymentBody.backups || [],
      });
      onDataChange?.(deploymentBody);
      setDirectory("");
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
        <ConcertDirectoryTree directories={directories} directory={directory} onChange={setDirectory} counts={directoryCounts} />
        <div className="concert-list-files">
          {error ? <div className="dialog-error">{error}</div> : <ConcertFileTable concerts={concerts} directory={directory} onOpen={onOpen} openKinds={openKinds} onSelect={onSelect} selectedKey={selectedKey} onPromote={onPromote} onRollback={onRollback} busy={busy} />}
        </div>
      </div>
    </aside>
  );
}
