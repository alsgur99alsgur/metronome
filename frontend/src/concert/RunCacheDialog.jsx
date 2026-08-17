import { useEffect, useMemo, useRef, useState } from "react";

const formatDateTime = (value) => {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

export default function RunCacheDialog({ replay, caches, onClose, onOpen, onDelete }) {
  const dialogRef = useRef(null);
  const orderedCaches = useMemo(
    () => [...caches].sort((left, right) =>
      String(left.createdAt || "").localeCompare(String(right.createdAt || "")),
    ),
    [caches],
  );
  const [selectedCacheId, setSelectedCacheId] = useState(
    orderedCaches[0]?.cacheId || "",
  );
  const selectedIndex = orderedCaches.findIndex(
    (cache) => cache.cacheId === selectedCacheId,
  );

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    if (orderedCaches.some((cache) => cache.cacheId === selectedCacheId)) return;
    setSelectedCacheId(orderedCaches[0]?.cacheId || "");
  }, [orderedCaches, selectedCacheId]);

  useEffect(() => {
    dialogRef.current
      ?.querySelector(".run-cache-row.active")
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedCacheId]);

  const moveSelection = (offset) => {
    if (!orderedCaches.length) return;
    const currentIndex = selectedIndex >= 0 ? selectedIndex : offset < 0 ? 0 : -1;
    const nextIndex =
      (currentIndex + offset + orderedCaches.length) % orderedCaches.length;
    setSelectedCacheId(orderedCaches[nextIndex].cacheId);
  };

  const onKeyDown = (event) => {
    if (event.target.closest?.(".run-cache-delete")) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Home" && orderedCaches[0]) {
      event.preventDefault();
      setSelectedCacheId(orderedCaches[0].cacheId);
    } else if (event.key === "End" && orderedCaches.at(-1)) {
      event.preventDefault();
      setSelectedCacheId(orderedCaches.at(-1).cacheId);
    } else if (event.key === "Enter" && selectedCacheId) {
      event.preventDefault();
      onOpen(selectedCacheId);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div className="modal-backdrop run-cache-backdrop" role="presentation">
      <div ref={dialogRef} className="run-cache-dialog" role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="dialog-header">
          <div>
            <div className="eyebrow">Run Cache</div>
            <h3>Select Cache</h3>
            <div className="muted">{replay.concertName}/{replay.id}</div>
          </div>
          <button className="icon-button" onClick={onClose} title="Close">x</button>
        </div>

        <div className="run-cache-list" role="listbox" aria-label="Run caches">
          <div className="replay-point-header run-cache-header" aria-hidden="true">
            <span>Created</span><span>Run ID</span><span>Status</span><span>Mode</span><span>Player</span><span />
          </div>
          {orderedCaches.map((cache) => (
            <div
              role="option"
              aria-selected={selectedCacheId === cache.cacheId}
              className={`replay-point-row run-cache-row ${selectedCacheId === cache.cacheId ? "active" : ""}`}
              key={cache.cacheId}
              onClick={() => setSelectedCacheId(cache.cacheId)}
              onDoubleClick={() => onOpen(cache.cacheId)}
            >
              <span>{formatDateTime(cache.createdAt)}</span>
              <span className="run-cache-id" title={cache.runId}>{cache.runId}</span>
              <span>{cache.status || "-"}</span>
              <span>{cache.mode || "all"}</span>
              <span title={cache.player || "-"}>{cache.player || "-"}</span>
              <button
                type="button"
                className="row-delete-button run-cache-delete"
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(cache.cacheId);
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>

        <div className="editor-actions">
          <div className="action-spacer" />
          <button onClick={onClose}>Close</button>
          <button className="primary-button" disabled={!selectedCacheId} onClick={() => onOpen(selectedCacheId)}>Open</button>
        </div>
      </div>
    </div>
  );
}
