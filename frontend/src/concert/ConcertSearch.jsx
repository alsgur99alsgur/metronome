import { useEffect, useMemo, useRef, useState } from "react";

const searchHeightCssVar = "--concert-search-height";
const minSearchHeight = 140;
const maxSearchHeight = 520;

const searchScopes = {
  all: "All",
  name: "Node name",
  code: "SQL / Code",
};

const searchableFields = {
  dbRead: [
    { key: "name", label: "Name" },
    { key: "connection", label: "Connection" },
    { key: "sql", label: "SQL" },
  ],
  python: [
    { key: "name", label: "Name" },
    { key: "code", label: "Python" },
  ],
  dbWrite: [
    { key: "name", label: "Name" },
    { key: "connection", label: "Connection" },
    { key: "sql", label: "SQL" },
  ],
};

const fieldMatchesScope = (field, scope) => {
  if (scope === "name") return field.key === "name";
  if (scope === "code") return ["sql", "code"].includes(field.key);
  return true;
};

const findLineMatches = (node, term, scope) => {
  const fields = searchableFields[node.type] || [];
  if (!fields.length || !term.trim()) return [];
  const needle = term.toLowerCase();

  return fields.filter((field) => fieldMatchesScope(field, scope)).flatMap((field) => {
    const text = String(node.data?.[field.key] || "");

    return text.split(/\r?\n/).flatMap((line, index) => {
      const column = line.toLowerCase().indexOf(needle);
      if (column === -1) return [];

      return {
        id: `${node.id}:${field.key}:${index + 1}`,
        nodeId: node.id,
        nodeName: node.data?.name || node.id,
        nodeType: node.type,
        position: node.position || { x: 0, y: 0 },
        field: field.key,
        fieldLabel: field.label,
        lineNumber: index + 1,
        startColumn: column + 1,
        endColumn: column + term.length + 1,
        term,
        line,
      };
    });
  });
};

export default function ConcertSearch({
  nodes,
  onClose,
  onOpenResult,
  showClose = true,
  showResizer = true,
  height,
  onHeightChange,
}) {
  const [inputTerm, setInputTerm] = useState("");
  const [submittedTerm, setSubmittedTerm] = useState("");
  const [scope, setScope] = useState("all");
  const [localSearchHeight, setLocalSearchHeight] = useState(220);
  const dragStartRef = useRef(null);
  const searchHeight = height ?? localSearchHeight;
  const setSearchHeight = onHeightChange ?? setLocalSearchHeight;

  useEffect(() => {
    document.documentElement.style.setProperty(searchHeightCssVar, `${searchHeight}px`);
    return () => {
      document.documentElement.style.removeProperty(searchHeightCssVar);
    };
  }, [searchHeight]);

  useEffect(() => {
    const onPointerMove = (event) => {
      if (!dragStartRef.current) return;
      event.preventDefault();
      const delta = dragStartRef.current.y - event.clientY;
      const nextHeight = Math.min(maxSearchHeight, Math.max(minSearchHeight, dragStartRef.current.height + delta));
      setSearchHeight(nextHeight);
    };

    const onPointerUp = () => {
      dragStartRef.current = null;
      document.body.classList.remove("resizing-concert-search");
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("resizing-concert-search");
    };
  }, []);

  const submitSearch = () => {
    setSubmittedTerm(inputTerm.trim());
  };

  const results = useMemo(() => {
    const value = submittedTerm.trim();
    if (!value) return [];
    return nodes
      .flatMap((node) => findLineMatches(node, value, scope))
      .sort((a, b) => {
        const ay = a.position?.y ?? 0;
        const by = b.position?.y ?? 0;
        if (ay !== by) return ay - by;

        const ax = a.position?.x ?? 0;
        const bx = b.position?.x ?? 0;
        if (ax !== bx) return ax - bx;

        return a.lineNumber - b.lineNumber;
      });
  }, [nodes, scope, submittedTerm]);

  return (
    <div className={`concert-search ${showResizer ? "" : "embedded"}`} onClick={(event) => event.stopPropagation()}>
      {showResizer && (
        <div
          className="concert-search-resizer"
          onPointerDown={(event) => {
            event.preventDefault();
            dragStartRef.current = { y: event.clientY, height: searchHeight };
            document.body.classList.add("resizing-concert-search");
          }}
          title="Resize search panel"
        />
      )}
      <div className="concert-search-header">
        <select
          className="concert-search-scope"
          value={scope}
          onChange={(event) => {
            setScope(event.target.value);
            setSubmittedTerm("");
          }}
        >
          {Object.entries(searchScopes).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
        <input
          className="concert-search-input"
          value={inputTerm}
          placeholder="Search node names, connections, SQL, and Python code"
          onChange={(event) => setInputTerm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submitSearch();
          }}
        />
        {showClose && (
          <button className="icon-button" onClick={onClose} title="Close Search">
            x
          </button>
        )}
      </div>

      <div className="concert-search-results">
        <div className="concert-search-summary">
          {submittedTerm ? (results.length ? `${results.length} results for "${submittedTerm}"` : `No results for "${submittedTerm}"`) : "Press Enter to search"}
        </div>
        <div className="concert-search-list">
          {results.map((result) => (
            <button
              className="concert-search-row"
              key={result.id}
              onClick={() => onOpenResult(result, "move")}
              onDoubleClick={() => onOpenResult(result, "open")}
              title="Click to go, double click to open editor"
            >
              <span className="concert-search-node">{result.nodeName}</span>
              <span className="concert-search-meta">
                {result.nodeType} / {result.fieldLabel} line {result.lineNumber}
              </span>
              <span className="concert-search-preview">{result.line.trim() || "(blank line)"}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
