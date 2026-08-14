import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const searchHeightCssVar = "--concert-search-height";
const minSearchHeight = 140;
const maxSearchHeight = 520;

const field = (key, label, value) => ({ key, label, value });

const arrayValues = (values) =>
  (Array.isArray(values) ? values : []).flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );

const searchableFields = (node) => {
  const data = node.data || {};
  const fields = [
    field("name", "Name", data.name),
    field("nodeId", "Node ID", node.id),
  ];

  if (["dbRead", "dbWrite"].includes(node.type)) {
    fields.push(
      field("connection", "Connection", data.connection),
      field("sql", "SQL", data.sql),
    );
  } else if (node.type === "python") {
    fields.push(field("code", "Python", data.code));
  } else if (node.type === "opl") {
    (data.sets || []).forEach((item, index) => {
      fields.push(
        field(`sets.${index}.name`, "Set name", item.name),
        field(`sets.${index}.inputNodeId`, "Set input node ID", item.inputNodeId),
        field(`sets.${index}.column`, "Set column", item.column),
      );
    });
    (data.params || []).forEach((item, index) => {
      fields.push(
        field(`params.${index}.name`, "Parameter name", item.name),
        field(`params.${index}.inputNodeId`, "Parameter input node ID", item.inputNodeId),
        field(`params.${index}.column`, "Parameter column", item.column),
        field(`params.${index}.indexSets`, "Parameter index sets", arrayValues(item.indexSets).join(", ")),
      );
    });
    (data.variables || []).forEach((item, index) => {
      fields.push(
        field(`variables.${index}.name`, "Variable name", item.name),
        field(`variables.${index}.domain`, "Variable domain", item.domain),
        field(`variables.${index}.indexSets`, "Variable index sets", arrayValues(item.indexSets).join(", ")),
      );
    });
    (data.expressions || []).forEach((item, index) => {
      fields.push(
        field(`expressions.${index}.name`, "Expression name", item.name),
        field(`expressions.${index}.formula`, "Expression formula", item.formula),
        field(`expressions.${index}.condition`, "Expression condition", item.condition),
        field(`expressions.${index}.description`, "Expression description", item.description),
      );
    });
  } else if (node.type === "concert") {
    fields.push(
      field("concertName", "Concert name", data.concertName),
      field("concertId", "Concert ID", data.concertId),
    );
    const inputValues = data.inputParamValues || data.inputParams || {};
    const variables = Array.isArray(data.calledConcertInputVariables)
      ? data.calledConcertInputVariables
      : [];
    variables.forEach((item, index) => {
      const name = String(item?.name || "").replace(/^\$/, "");
      fields.push(
        field(`calledConcertInputVariables.${index}.name`, "Input parameter name", name),
        field(`inputParamValues.${name}`, "Input parameter value", inputValues[name] ?? inputValues[`$${name}`]),
      );
    });
    Object.entries(inputValues).forEach(([key, value]) => {
      if (!variables.some((item) => String(item?.name || "").replace(/^\$/, "") === key.replace(/^\$/, ""))) {
        fields.push(
          field(`inputParamValues.${key}.name`, "Input parameter name", key),
          field(`inputParamValues.${key}`, "Input parameter value", value),
        );
      }
    });
  } else if (["cacheRead", "cacheWrite"].includes(node.type)) {
    fields.push(field("resourceName", "Cache name", data.resourceName));
    if (node.type.endsWith("Write")) {
      fields.push(field("condition", "Delete condition", data.condition));
    }
  } else if (node.type === "loopIn") {
    fields.push(field("groupByColumns", "Group by columns", data.groupByColumns));
  } else if (node.type === "loopOut") {
    fields.push(field("maxIterations", "Max iterations", data.maxIterations));
    (data.stopConditions || []).forEach((item, index) => {
      fields.push(
        field(`stopConditions.${index}.column`, "Stop condition column", item.column),
        field(`stopConditions.${index}.operator`, "Stop condition operator", item.operator),
        field(`stopConditions.${index}.value`, "Stop condition value", item.value),
      );
    });
  }

  return fields;
};

const findLineMatches = (node, term) => {
  const fields = searchableFields(node);
  if (!term.trim()) return [];
  const needle = term.toLowerCase();

  return fields.flatMap((field) => {
    const text = String(field.value ?? "");

    return text.split(/\r?\n/).flatMap((line, index) => {
      const column = line.toLowerCase().indexOf(needle);
      if (column === -1) return [];

      return {
        id: `${node.id}:${field.key}:${index + 1}`,
        nodeId: node.id,
        nodeName: node.data.name,
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
  const [localSearchHeight, setLocalSearchHeight] = useState(220);
  const dragStartRef = useRef(null);
  const searchHeight = height ?? localSearchHeight;
  const setSearchHeight = useCallback(
    (nextHeight) => (onHeightChange ?? setLocalSearchHeight)(nextHeight),
    [onHeightChange],
  );

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
  }, [setSearchHeight]);

  const submitSearch = () => {
    setSubmittedTerm(inputTerm.trim());
  };

  const results = useMemo(() => {
    const value = submittedTerm.trim();
    if (!value) return [];
    return nodes
      .flatMap((node) => findLineMatches(node, value))
      .sort((a, b) => {
        const ay = a.position?.y ?? 0;
        const by = b.position?.y ?? 0;
        if (ay !== by) return ay - by;

        const ax = a.position?.x ?? 0;
        const bx = b.position?.x ?? 0;
        if (ax !== bx) return ax - bx;

        return a.lineNumber - b.lineNumber;
      });
  }, [nodes, submittedTerm]);

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
        <input
          className="concert-search-input"
          value={inputTerm}
          placeholder="Search all node fields"
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
