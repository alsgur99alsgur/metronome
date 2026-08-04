import { useState } from "react";

export const folderOf = (name) => name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";

export const folderRows = (directories) => {
  const children = new Map();
  directories.filter(Boolean).forEach((path) => {
    const parent = folderOf(path);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(path);
  });
  const rows = [{ path: "", depth: 0 }];
  const append = (parent, depth) => {
    (children.get(parent) || []).sort().forEach((path) => {
      rows.push({ path, depth });
      append(path, depth + 1);
    });
  };
  append("", 1);
  return rows;
};

export function ConcertFileTable({ concerts, directory, onOpen, openKinds = ["concert"], onSelect, selectedKey, onPromote, onRollback, busy }) {
  const [expandedBackups, setExpandedBackups] = useState(() => new Set());
  const visible = concerts.filter((item) => folderOf(item.name) === directory);
  const updatedAt = (value) => value ? new Date(value * 1000).toLocaleString() : "";
  const kindLabel = { concert: "Concert", rehearsal: "Rehearsal", backup: "Backup" };
  const regular = visible.filter((item) => item.kind !== "backup");
  const backupGroups = Object.entries(visible.filter((item) => item.kind === "backup").reduce((groups, item) => {
    (groups[item.name] ||= []).push(item);
    return groups;
  }, {}));
  const row = (item, child = false) => {
    const openable = Boolean(onOpen && openKinds.includes(item.kind));
    const selectable = Boolean(onSelect);
    const itemKey = `${item.kind}:${item.path}`;
    const name = child ? item.path.split("/").pop().replace(/\.concert$/, "") : item.name.split("/").pop();
    return (
      <div
        className={`concert-file-row ${openable ? "openable" : ""} ${selectable ? "selectable" : ""} ${selectedKey === itemKey ? "selected-file" : ""} ${child ? "backup-child" : ""}`}
        key={`${item.kind}-${item.path}`}
        onClick={() => selectable && onSelect(item)}
        onDoubleClick={() => openable && onOpen(item.name, item)}
      >
        <span>{child && <span className="concert-tree-branch">└</span>}{name}</span>
        <span>{kindLabel[item.kind]}</span>
        <span>{item.version}</span>
        <span>{updatedAt(item.updatedAt)}</span>
        <span className="concert-file-actions">
          {item.kind === "rehearsal" && onPromote && <button className="primary-button" disabled={busy} onClick={(event) => { event.stopPropagation(); onPromote(item); }}>Promote</button>}
          {item.kind === "backup" && onRollback && <button className="danger-button" disabled={busy} onClick={(event) => { event.stopPropagation(); onRollback(item); }}>Rollback</button>}
        </span>
      </div>
    );
  };
  return (
    <div className="concert-file-table">
      <div className="concert-file-row concert-file-header">
        <span>Name</span><span>Type</span><span>Version</span><span>Updated At</span><span>Action</span>
      </div>
      {regular.map((item) => row(item))}
      {backupGroups.map(([name, items]) => (
        <div className="concert-backup-group" key={`backup-${name}`}>
          <div
            className="concert-file-row concert-backup-parent"
            onClick={() => setExpandedBackups((current) => {
              const next = new Set(current);
              if (next.has(name)) next.delete(name); else next.add(name);
              return next;
            })}
          >
            <span><span className="concert-tree-branch">{expandedBackups.has(name) ? "▾" : "▸"}</span>{name.split("/").pop()}</span>
            <span>Backup</span><span>{items.length} versions</span><span /><span />
          </div>
          {expandedBackups.has(name) && items.map((item) => row(item, true))}
        </div>
      ))}
      {!visible.length && <div className="column-empty">No deployed Concerts.</div>}
    </div>
  );
}
