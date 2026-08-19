import { useEffect, useState } from "react";
import OutputColumnsTitle from "./OutputColumnsTitle";

function ColumnsPanel({ title, columns = [], emptyText }) {
  return (
    <aside className="column-side-panel">
      <div className="column-title">{title}</div>
      <div className="column-list">
        {columns.length ? columns.map((column) => (
          <div className="column-row" key={`${column.name}-${column.type}`}>
            <span className="column-name">{column.name}</span>
            <span className="column-type">{column.type}</span>
          </div>
        )) : <div className="column-empty">{emptyText}</div>}
      </div>
    </aside>
  );
}

export default function ResourceEditor({
  data,
  onChange,
  write = false,
  apiBaseUrl,
  onRefreshOutputColumns,
  refreshingOutputColumns = false,
  inputDataframes = [],
}) {
  const operation = data.operation || "append";
  const scope = data.scope || "stage";
  const [stageResources, setStageResources] = useState([]);
  const [columns, setColumns] = useState([]);
  const [schemaMessage, setSchemaMessage] = useState("Select a Stage resource.");
  const resourceLabel = "Cache";
  const inputDataframe = inputDataframes[0] || null;
  const inputColumns = inputDataframe?.columns || [];
  const inputMessage = inputDataframe?.status === "not_run"
    ? "Run parent node to inspect columns."
    : "No connected input DataFrame.";

  useEffect(() => {
    if (!apiBaseUrl) return undefined;
    const controller = new AbortController();
    fetch(`${apiBaseUrl}/stage-resources`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load Stage ${resourceLabel}s.`);
        return response.json();
      })
      .then((body) => {
        setStageResources(
          (body.resources || [])
            .map((resource) => resource.name)
            .sort((left, right) => left.localeCompare(right)),
        );
      })
      .catch((error) => {
        if (error.name !== "AbortError") setStageResources([]);
      });
    return () => controller.abort();
  }, [apiBaseUrl, resourceLabel]);

  useEffect(() => {
    const resourceName = data.resourceName || "";
    if (scope !== "stage" || !resourceName || !apiBaseUrl) {
      setColumns([]);
      setSchemaMessage("Select a Stage resource.");
      return undefined;
    }
    const controller = new AbortController();
    setSchemaMessage("Loading columns...");
    fetch(`${apiBaseUrl}/stage-resources/${encodeURIComponent(resourceName)}/schema`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Failed to load columns.");
        return response.json();
      })
      .then((body) => {
        setColumns(body.columns || []);
        setSchemaMessage("No columns defined.");
      })
      .catch((error) => {
        if (error.name !== "AbortError") {
          setColumns([]);
          setSchemaMessage(error.message);
        }
      });
    return () => controller.abort();
  }, [apiBaseUrl, data.resourceName, scope]);

  const setScope = (nextScope) => {
    onChange({
      ...data,
      scope: nextScope,
      resourceName: nextScope === "stage" ? stageResources[0] || "" : "",
    });
  };

  return (
    <div className={`resource-editor-grid${write ? scope === "stage" ? " cache-write-stage" : " cache-write-concert" : scope === "stage" ? " columns-right" : " without-columns"}`}>
      {write && (
        <ColumnsPanel
          title="Input Columns"
          columns={inputColumns}
          emptyText={inputMessage}
        />
      )}
      <div className="editor-form">
      <div className="resource-scope-radios">
        <label><input type="radio" checked={scope === "stage"} onChange={() => setScope("stage")} />for Stage</label>
        <label><input type="radio" checked={scope === "concert"} onChange={() => setScope("concert")} />for Concert</label>
      </div>
      {scope === "stage" ? (
        <label className="field-label">
          {resourceLabel} Name
          <select className="resource-name-select" value={data.resourceName || ""} onChange={(event) => onChange({ ...data, resourceName: event.target.value })}>
            <option value="" disabled>Select a Stage {resourceLabel.toLowerCase()}</option>
            {stageResources.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      ) : (
        <label className="field-label">
          {resourceLabel} Name
          <input className="text-input resource-name-input" value={data.resourceName || ""} onChange={(event) => onChange({ ...data, resourceName: event.target.value })} placeholder="cache_name" />
        </label>
      )}
      {write && (
        <div className="resource-operation-section">
          <div className="field-label">Operation</div>
          <div className="resource-scope-radios">
            <label>
              <input
                type="radio"
                checked={operation === "append"}
                onChange={() => onChange({ ...data, operation: "append" })}
              />
              Append
            </label>
            <label>
              <input
                type="radio"
                checked={operation === "delete"}
                onChange={() => onChange({ ...data, operation: "delete" })}
              />
              Delete
            </label>
          </div>
          {operation === "delete" && (
            <label className="field-label resource-query-field">
              Pandas Query Condition
              <input
                className="text-input resource-name-input"
                value={data.condition || ""}
                onChange={(event) => onChange({ ...data, condition: event.target.value })}
                placeholder={"status == $target_status and amount >= $minimum_amount"}
              />
              <span className="field-hint">Use $variable_name for Input and Global variables.</span>
            </label>
          )}
        </div>
      )}
      </div>
      {scope === "stage" && write && (
        <ColumnsPanel
          title="Cache Columns"
          columns={columns}
          emptyText={schemaMessage}
        />
      )}
      {scope === "stage" && !write && <aside className="column-side-panel">
        <OutputColumnsTitle
          onRefresh={onRefreshOutputColumns}
          refreshing={refreshingOutputColumns}
        />
        <div className="column-list">
          {columns.length ? columns.map((column) => (
            <div className="column-row" key={`${column.name}-${column.type}`}>
              <span className="column-name">{column.name}</span>
              <span className="column-type">{column.type}</span>
            </div>
          )) : <div className="column-empty">{schemaMessage}</div>}
        </div>
      </aside>}
    </div>
  );
}
