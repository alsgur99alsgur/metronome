import { useEffect, useMemo, useRef, useState } from "react";

const outputHeightCssVar = "--concert-output-height";
const minOutputHeight = 140;
const maxOutputHeight = 520;

const outputNodeTypes = new Set(["dbRead", "python", "dbWrite", "concert", "concertInput", "concertOutput", "cacheRead", "cacheWrite"]);
const nodeTypeLabel = (type) => ({ dbRead: "DB Read", dbWrite: "DB Write" })[type] || type;

const formatDuration = (value) => {
  if (value == null) return "";
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
};

const resultSummary = (result) => {
  if (!result) return "";
  if (result.kind === "dataframe") return "";
  if (result.kind === "value") return "value";
  return result.kind || "";
};

export default function ConcertOutputPanel({
  nodes,
  run,
  selectedNode,
  onClose,
  onOpenNode,
  showClose = true,
  showResizer = true,
  height,
  onHeightChange,
}) {
  const [localOutputHeight, setLocalOutputHeight] = useState(220);
  const dragStartRef = useRef(null);
  const outputHeight = height ?? localOutputHeight;
  const setOutputHeight = onHeightChange ?? setLocalOutputHeight;

  useEffect(() => {
    document.documentElement.style.setProperty(outputHeightCssVar, `${outputHeight}px`);
    return () => {
      document.documentElement.style.removeProperty(outputHeightCssVar);
    };
  }, [outputHeight]);

  useEffect(() => {
    const onPointerMove = (event) => {
      if (!dragStartRef.current) return;
      event.preventDefault();
      const delta = dragStartRef.current.y - event.clientY;
      const nextHeight = Math.min(maxOutputHeight, Math.max(minOutputHeight, dragStartRef.current.height + delta));
      setOutputHeight(nextHeight);
    };

    const onPointerUp = () => {
      dragStartRef.current = null;
      document.body.classList.remove("resizing-concert-output");
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("resizing-concert-output");
    };
  }, [setOutputHeight]);

  const outputRows = useMemo(
    () =>
      nodes
        .filter((node) => outputNodeTypes.has(node.type))
        .map((node) => {
          const nodeRun = run?.nodes?.[node.id];
          const status = nodeRun?.status || node.data?.status || "skipped";
          const duration = nodeRun?.durationMs ?? node.data?.runDurationMs;
          const result = nodeRun?.result;
          const cacheSummary = nodeRun?.rows != null
            ? `${nodeRun.rows} rows / ${(nodeRun.columns || []).length} columns`
            : "";
          const detail = nodeRun?.error || nodeRun?.logs || cacheSummary || resultSummary(result) || "";
          const fullDetail = nodeRun?.logs || nodeRun?.error || cacheSummary || resultSummary(result) || "";

          return {
            id: node.id,
            name: node.data.name,
            type: node.type,
            status,
            duration,
            detail,
            fullDetail,
            error: nodeRun?.error || "",
            logs: nodeRun?.logs || "",
            result,
          };
        }),
    [nodes, run],
  );

  const selectedOutput = selectedNode
    ? outputRows.find((row) => row.id === selectedNode.id)
    : null;
  const errorCount = outputRows.filter((row) => row.status === "error").length;

  return (
    <div className={`concert-output ${showResizer ? "" : "embedded"}`} onClick={(event) => event.stopPropagation()}>
      {showResizer && (
        <div
          className="concert-output-resizer"
          onPointerDown={(event) => {
            event.preventDefault();
            dragStartRef.current = { y: event.clientY, height: outputHeight };
            document.body.classList.add("resizing-concert-output");
          }}
          title="Resize output panel"
        />
      )}
      <div className="concert-output-header">
        <div>
          <div className="eyebrow">Output</div>
          <h2>Run Output</h2>
        </div>
        <div className="concert-output-summary">
          {errorCount ? `${errorCount} error${errorCount === 1 ? "" : "s"}` : "No errors"}
        </div>
        {showClose && (
          <button className="icon-button" onClick={onClose} title="Close Output">
            x
          </button>
        )}
      </div>

      <div className="concert-output-body">
        <div className="concert-output-list">
          {outputRows.length ? (
            outputRows.map((row) => (
              <button
                className={`concert-output-row ${selectedNode?.id === row.id ? "selected" : ""}`}
                key={row.id}
                onClick={() => onOpenNode(row.id, "move")}
                onDoubleClick={() => onOpenNode(row.id, "open")}
                title="Click to go, double click to open editor"
              >
                <span className={`status-dot ${row.status}`} />
                <span className="concert-output-node">{row.name}</span>
                <span className="concert-output-meta">
                  {nodeTypeLabel(row.type)} / {row.status}
                  {row.duration != null ? ` / ${formatDuration(row.duration)}` : ""}
                </span>
                <span className={`concert-output-preview ${row.error ? "error" : ""}`}>
                  {row.detail || "(no output)"}
                </span>
              </button>
            ))
          ) : (
            <div className="concert-output-empty">Run a Concert to see DataFrame output.</div>
          )}
        </div>

        <div className="concert-output-detail">
          {selectedOutput ? (
            <>
              <div className="result-title">{selectedOutput.name}</div>
              <pre className={selectedOutput.error ? "error-text" : ""}>
                {selectedOutput.fullDetail || "No output for this node."}
              </pre>
            </>
          ) : (
            <div className="concert-output-empty">Select a node to inspect its latest output.</div>
          )}
        </div>
      </div>
    </div>
  );
}
