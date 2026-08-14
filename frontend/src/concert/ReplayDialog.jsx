import { useEffect, useMemo, useRef, useState } from "react";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowRightIcon from "@mui/icons-material/KeyboardArrowRight";

const safeName = (value) => {
  const safe = (value || "task").replace(/\W+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) return "task";
  return /^\d/.test(safe) ? `task_${safe}` : safe;
};

const normalizeVariableName = (value) => {
  const name = String(value || "").trim().replace(/^\$+/, "");
  return name ? `$${safeName(name)}` : "$var";
};

const formatParamValue = (value) => {
  if (value === undefined) return "";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const formatDateFolder = (value) => {
  const text = String(value || "");
  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return text || "unknown_date";
};

const formatHourFolder = (value) => {
  const text = String(value || "");
  if (/^\d{2}$/.test(text)) return `${text}:00`;
  return text || "unknown_hour";
};

const formatReplayTime = (value) => {
  const text = String(value || "");
  const match = text.match(/^\d{8}_(\d{2})(\d{2})(\d{2})(?:_(\d+))?/);
  if (!match) return text;
  const [, hour, minute, second, microsecond] = match;
  return `${hour}:${minute}:${second}${microsecond ? `.${microsecond}` : ""}`;
};

const replayTreePath = (replay) => {
  const created = String(replay.createdAt || replay.id || "");
  const timestamp = String(replay.id || created);
  return {
    date: /^\d{8}/.test(timestamp) ? timestamp.slice(0, 8) : "unknown_date",
    hour:
      /^\d{8}_\d{2}/.test(timestamp)
        ? timestamp.slice(9, 11)
        : "unknown_hour",
    leaf: replay.id || timestamp,
  };
};

const buildReplayTree = (rows) => {
  const dateMap = new Map();
  rows.forEach((replay) => {
    const path = replayTreePath(replay);
    if (!dateMap.has(path.date)) {
      dateMap.set(path.date, new Map());
    }
    const hourMap = dateMap.get(path.date);
    if (!hourMap.has(path.hour)) {
      hourMap.set(path.hour, []);
    }
    hourMap.get(path.hour).push({ ...replay, treeLeaf: path.leaf });
  });

  return [...dateMap.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, hourMap]) => ({
      date,
      hours: [...hourMap.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([hour, items]) => ({
          hour,
          items: items.sort((left, right) => left.id.localeCompare(right.id)),
        })),
    }));
};

const replayTreeKeys = (replayId) => {
  const path = replayTreePath({ id: replayId });
  return {
    dateKey: path.date,
    hourKey: `${path.date}/${path.hour}`,
  };
};

const collapsedTreeState = (tree, openReplayId = "") => {
  const openKeys = openReplayId ? replayTreeKeys(openReplayId) : {};
  const collapsedDates = new Set();
  const collapsedHours = new Set();
  tree.forEach((dateGroup) => {
    if (dateGroup.date !== openKeys.dateKey) {
      collapsedDates.add(dateGroup.date);
    }
    dateGroup.hours.forEach((hourGroup) => {
      const hourKey = `${dateGroup.date}/${hourGroup.hour}`;
      if (hourKey !== openKeys.hourKey) {
        collapsedHours.add(hourKey);
      }
    });
  });
  return { collapsedDates, collapsedHours };
};

const inputParamRows = (replay) => {
  if (!replay) return [];
  const rawCalledParams =
    replay.calledParams && Object.keys(replay.calledParams).length
      ? replay.calledParams
      : replay.inputParams || {};
  const calledParams = Object.fromEntries(
    Object.entries(rawCalledParams).map(([name, value]) => [
      String(name).replace(/^\$+/, ""),
      value,
    ]),
  );
  return (replay.inputVariables || []).map((item) => {
    const name = normalizeVariableName(item.name).replace(/^\$+/, "");
    return {
      name: `$${name}`,
      value: formatParamValue(calledParams?.[name]),
      defaultValue: formatParamValue(item.defaultValue),
    };
  });
};

const callerParamRows = (replay) =>
  Object.entries(replay?.callerParams || {}).map(([name, value]) => ({
    name: `$${String(name).replace(/^\$+/, "")}`,
    value: formatParamValue(value),
  }));

const formatSource = (replay) => {
  return replay.sourceLabel;
};

const formatSourceDetail = (replay) => {
  return replay.sourceDetail;
};

const formatCaller = (replay) => {
  return replay.callerName || "-";
};

export default function ReplayDialog({
  replays,
  selectedReplayId,
  servers,
  serverName,
  onServerChange,
  onSelect,
  onClose,
  onOpen,
  onCacheOpen,
  onClearCache,
}) {
  const dialogRef = useRef(null);
  const [draftReplayId, setDraftReplayId] = useState(selectedReplayId || "");
  const [collapsedDates, setCollapsedDates] = useState(() => new Set());
  const [collapsedHours, setCollapsedHours] = useState(() => new Set());
  const rows = useMemo(
    () =>
      replays.map((replay) => ({
        ...replay,
        sourceSummary: formatSource(replay),
        sourceDetail: formatSourceDetail(replay),
        callerSummary: formatCaller(replay),
      })),
    [replays],
  );
  const tree = useMemo(() => buildReplayTree(rows), [rows]);
  const orderedReplays = useMemo(
    () => tree.flatMap((dateGroup) =>
      dateGroup.hours.flatMap((hourGroup) => hourGroup.items),
    ),
    [tree],
  );
  const selectedIndex = orderedReplays.findIndex(
    (replay) => replay.id === draftReplayId,
  );
  const selectedReplay = selectedIndex >= 0 ? orderedReplays[selectedIndex] : null;
  const paramRows = useMemo(
    () => inputParamRows(selectedReplay),
    [selectedReplay],
  );
  const callerRows = useMemo(
    () => callerParamRows(selectedReplay),
    [selectedReplay],
  );

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const nextState = collapsedTreeState(tree, draftReplayId);
    setCollapsedDates(nextState.collapsedDates);
    setCollapsedHours(nextState.collapsedHours);
  }, [draftReplayId, tree]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector(".replay-point-row.active")
        ?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [collapsedDates, collapsedHours, draftReplayId]);

  const moveSelection = (offset) => {
    if (!orderedReplays.length) return;
    if (selectedIndex < 0) {
      setDraftReplayId(
        orderedReplays[offset < 0 ? orderedReplays.length - 1 : 0].id,
      );
      return;
    }
    const nextIndex = Math.max(
      0,
      Math.min(orderedReplays.length - 1, selectedIndex + offset),
    );
    setDraftReplayId(orderedReplays[nextIndex].id);
  };

  const toggleDate = (dateKey) => {
    setCollapsedDates((current) => {
      const next = new Set(current);
      if (next.has(dateKey)) {
        next.delete(dateKey);
      } else {
        next.add(dateKey);
      }
      return next;
    });
  };

  const toggleHour = (hourKey) => {
    setCollapsedHours((current) => {
      const next = new Set(current);
      if (next.has(hourKey)) {
        next.delete(hourKey);
      } else {
        next.add(hourKey);
      }
      return next;
    });
  };

  const confirmSelection = () => {
    if (!draftReplayId) return;
    onSelect(draftReplayId);
    onOpen();
  };

  const confirmCacheOpen = () => {
    if (!selectedReplay?.cache?.available) return;
    onCacheOpen?.(selectedReplay);
  };

  const clearCache = () => {
    if (!selectedReplay?.cache?.available) return;
    onClearCache?.(selectedReplay);
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.target.closest?.("select")) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      if (orderedReplays[0]) setDraftReplayId(orderedReplays[0].id);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      if (orderedReplays.at(-1)) setDraftReplayId(orderedReplays.at(-1).id);
      return;
    }
    if (event.key === "Enter" && draftReplayId) {
      event.preventDefault();
      confirmSelection();
      return;
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div
        ref={dialogRef}
        className="replay-dialog"
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="dialog-header">
          <div>
            <div className="eyebrow">Replay</div>
            <h3>Replay Points</h3>
          </div>
          <label className="replay-server-selector">
            <span>Server</span>
            <select
              value={serverName}
              onChange={async (event) => {
                const changed = await onServerChange(event.target.value);
                if (!changed) return;
                setDraftReplayId("");
                onSelect("");
              }}
            >
              {servers.map((server) => (
                <option key={server.name} value={server.name}>
                  {server.name}
                </option>
              ))}
            </select>
          </label>
          <button className="icon-button" onClick={onClose} title="Close">
            x
          </button>
        </div>

        <div className="replay-dialog-body">
          <div className="replay-tree-panel">
            {replays.length === 0 && <div className="muted">No replay points.</div>}
            {replays.length > 0 && (
              <>
                <div className="replay-point-header">
                  <span>Date / Time</span>
                  <span>Version</span>
                  <span>Play Type</span>
                  <span>Player</span>
                  <span>Owner</span>
                </div>
                <div className="replay-tree-view" role="tree" aria-label="Replay points">
                  {tree.map((dateGroup) => {
                    const isDateCollapsed = collapsedDates.has(dateGroup.date);
                    return (
                      <div className="replay-tree-date" key={dateGroup.date} role="treeitem" aria-expanded={!isDateCollapsed}>
                        <button
                          className="replay-tree-folder"
                          onClick={() => toggleDate(dateGroup.date)}
                          type="button"
                        >
                          <span className="replay-tree-toggle">
                            {isDateCollapsed ? (
                              <KeyboardArrowRightIcon fontSize="inherit" />
                            ) : (
                              <KeyboardArrowDownIcon fontSize="inherit" />
                            )}
                          </span>
                          <span>{formatDateFolder(dateGroup.date)}</span>
                        </button>
                        {!isDateCollapsed && (
                          <div className="replay-tree-children" role="group">
                            {dateGroup.hours.map((hourGroup) => {
                              const hourKey = `${dateGroup.date}/${hourGroup.hour}`;
                              const isHourCollapsed = collapsedHours.has(hourKey);
                              return (
                                <div className="replay-tree-hour" key={hourKey} role="treeitem" aria-expanded={!isHourCollapsed}>
                                  <button
                                    className="replay-tree-folder hour"
                                    onClick={() => toggleHour(hourKey)}
                                    type="button"
                                  >
                                    <span className="replay-tree-toggle">
                                      {isHourCollapsed ? (
                                        <KeyboardArrowRightIcon fontSize="inherit" />
                                      ) : (
                                        <KeyboardArrowDownIcon fontSize="inherit" />
                                      )}
                                    </span>
                                    <span>{formatHourFolder(hourGroup.hour)}</span>
                                  </button>
                                  {!isHourCollapsed && (
                                    <div className="replay-tree-children" role="group">
                                      {hourGroup.items.map((replay) => (
                                        <button
                                          className={`replay-point-row ${draftReplayId === replay.id ? "active" : ""}`}
                                          key={`${replay.concertName}-${replay.id}`}
                                          onClick={() => setDraftReplayId(replay.id)}
                                          role="treeitem"
                                        >
                                          <span className="replay-point-id" title={replay.id}>
                                            {formatReplayTime(replay.treeLeaf)}
                                          </span>
                                          <span className="replay-point-version" title={replay.version || "-"}>
                                            {replay.version || "-"}
                                          </span>
                                          <span className={`replay-point-source ${replay.sourceKind || ""}`}>
                                            {replay.sourceSummary}
                                          </span>
                                          <span className="replay-point-caller" title={replay.callerSummary}>
                                            {replay.callerSummary}
                                          </span>
                                          <span className="replay-point-owner" title={replay.owner || "Local"}>
                                            {replay.owner || "Local"}
                                          </span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div className="replay-param-panel">
            <div className="replay-param-section">
              <div className="replay-param-title">Input Parameters</div>
              {paramRows.length ? (
                <div className="replay-param-grid">
                  <div className="replay-param-header">Name</div>
                  <div className="replay-param-header">Value</div>
                  <div className="replay-param-header">Default</div>
                  {paramRows.map((param) => (
                    <div className="replay-param-row" key={param.name}>
                      <span className="replay-param-name">{param.name}</span>
                      <span className="replay-param-value" title={param.value}>{param.value}</span>
                      <span className="replay-param-value" title={param.defaultValue}>{param.defaultValue}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="replay-param-empty">No input parameters.</div>
              )}
            </div>
            <div className="replay-param-section">
              <div className="replay-param-title">Caller Input Parameters</div>
              {callerRows.length > 0 ? (
                <div className="replay-caller-param-grid">
                  <div className="replay-param-header">Name</div>
                  <div className="replay-param-header">Value</div>
                  {callerRows.map((param) => (
                    <div className="replay-param-row" key={param.name}>
                      <span className="replay-param-name">{param.name}</span>
                      <span className="replay-param-value" title={param.value}>{param.value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="replay-param-empty">No caller input parameters.</div>
              )}
            </div>
          </div>
        </div>

        <div className="editor-actions">
          <button className="danger-button" disabled={!selectedReplay?.cache?.available} onClick={clearCache}>
            Clear Cache
          </button>
          <div className="action-spacer" />
          <button onClick={onClose}>Close</button>
          <button disabled={!selectedReplay?.cache?.available} onClick={confirmCacheOpen}>
            Cache Open
          </button>
          <button className="primary-button" disabled={!draftReplayId} onClick={confirmSelection}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
