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

export function ConcertFileTable({ concerts, directory, onOpen, openKinds = ["playing"], onSelect, selectedKey, onPromote, onRollback, onMove, canMove, onDelete, busy }) {
  const [expandedBackups, setExpandedBackups] = useState(() => new Set());
  const visible = concerts.filter((item) => folderOf(item.name) === directory);
  const updatedAt = (value) => value ? new Date(value * 1000).toLocaleString() : "";
  const kindLabel = { playing: "Playing", rehearsal: "Rehearsal", backup: "Backup" };
  const fileGroups = Object.entries(visible.reduce((groups, item) => {
    (groups[item.name] ||= []).push(item);
    return groups;
  }, {})).sort(([left], [right]) => left.localeCompare(right));
  const showActions = Boolean(onPromote || onRollback || onMove || onDelete);
  const row = (item, child = false) => {
    const openable = Boolean(onOpen && openKinds.includes(item.kind));
    const selectable = Boolean(onSelect);
    const itemKey = `${item.kind}:${item.path}`;
    const name = child ? item.path.split("/").pop().replace(/\.concert$/, "") : item.name.split("/").pop();
    return (
      <div
        className={`concert-file-row concert-kind-row-${item.kind} ${showActions ? "with-actions" : ""} ${openable ? "openable" : ""} ${selectable ? "selectable" : ""} ${selectedKey === itemKey ? "selected-file" : ""} ${child ? "backup-child" : ""}`}
        key={`${item.kind}-${item.path}`}
        onClick={() => selectable && onSelect(item)}
        onDoubleClick={() => openable && onOpen(item.name, item)}
      >
        <span>{child && <span className="concert-tree-branch">└</span>}{name}</span>
        <span className={`concert-kind concert-kind-${item.kind}`}>{kindLabel[item.kind]}</span>
        <span>{item.version}</span>
        <span>{updatedAt(item.updatedAt)}</span>
        {showActions && <span className="concert-file-actions">
          {item.kind === "rehearsal" && onPromote && <button className="primary-button" disabled={busy} onClick={(event) => { event.stopPropagation(); onPromote(item); }}>Promote</button>}
          {item.kind === "backup" && onRollback && <button className="danger-button" disabled={busy} onClick={(event) => { event.stopPropagation(); onRollback(item); }}>Rollback</button>}
          {item.kind === "playing" && onMove && <button disabled={busy || !canMove?.(item)} onClick={(event) => { event.stopPropagation(); onMove(item); }}>Move Folder</button>}
          {onDelete && <button className="danger-button" disabled={busy} onClick={(event) => { event.stopPropagation(); onDelete(item); }}>Delete</button>}
        </span>}
      </div>
    );
  };
  const backupGroup = (name, items) => (
    <div className="concert-backup-group" key={`backup-${name}`}>
      <div
        className={`concert-file-row concert-backup-parent concert-kind-row-backup ${showActions ? "with-actions" : ""}`}
        onClick={() => setExpandedBackups((current) => {
          const next = new Set(current);
          if (next.has(name)) next.delete(name); else next.add(name);
          return next;
        })}
      >
        <span><span className="concert-tree-branch">{expandedBackups.has(name) ? "▾" : "▸"}</span>{name.split("/").pop()}</span>
        <span className="concert-kind concert-kind-backup">Backup</span><span>{items.length} versions</span><span />{showActions && <span />}
      </div>
      {expandedBackups.has(name) && items.map((item) => row(item, true))}
    </div>
  );
  return (
    <div className="concert-file-table">
      <div className={`concert-file-row concert-file-header ${showActions ? "with-actions" : ""}`}>
        <span>Name</span><span>Type</span><span>Version</span><span>Updated At</span>{showActions && <span>Action</span>}
      </div>
      {fileGroups.flatMap(([name, items]) => {
        const playingRows = items.filter((item) => item.kind === "playing").map((item) => row(item));
        const rehearsalRows = items.filter((item) => item.kind === "rehearsal").map((item) => row(item));
        const backups = items.filter((item) => item.kind === "backup");
        return [...playingRows, ...rehearsalRows, ...(backups.length ? [backupGroup(name, backups)] : [])];
      })}
      {!visible.length && <div className="column-empty">No deployed files.</div>}
    </div>
  );
}
