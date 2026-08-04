import { useEffect, useState } from "react";

export default function ResourceEditor({ data, onChange, kind, write = false, apiBaseUrl }) {
  const operation = data.operation || "append";
  const scope = data.scope || "stage";
  const [stageResources, setStageResources] = useState([]);
  const [columns, setColumns] = useState([]);
  const [schemaMessage, setSchemaMessage] = useState("Select a Stage resource.");
  const resourceLabel = kind === "cache" ? "Cache" : "File";

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
            .filter((resource) => resource.kind === kind)
            .map((resource) => resource.name)
            .sort((left, right) => left.localeCompare(right)),
        );
      })
      .catch((error) => {
        if (error.name !== "AbortError") setStageResources([]);
      });
    return () => controller.abort();
  }, [apiBaseUrl, kind, resourceLabel]);

  useEffect(() => {
    const resourceName = data.resourceName || "";
    if (scope !== "stage" || !resourceName || !apiBaseUrl) {
      setColumns([]);
      setSchemaMessage(scope === "stage" ? "Select a Stage resource." : "Concert resource schema is available after execution.");
      return undefined;
    }
    const controller = new AbortController();
    setSchemaMessage("Loading columns...");
    fetch(`${apiBaseUrl}/stage-resources/${encodeURIComponent(kind)}/${encodeURIComponent(resourceName)}/schema`, { signal: controller.signal })
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
  }, [apiBaseUrl, data.resourceName, kind, scope]);

  const setScope = (nextScope) => {
    onChange({
      ...data,
      scope: nextScope,
      resourceName: nextScope === "stage" ? stageResources[0] || "" : "",
    });
  };

  return (
    <div className="resource-editor-grid">
      <aside className="column-side-panel">
        <div className="column-title">Columns</div>
        <div className="column-list">
          {columns.length ? columns.map((column) => (
            <div className="column-row" key={`${column.name}-${column.type}`}>
              <span className="column-name">{column.name}</span>
              <span className="column-type">{column.type}</span>
            </div>
          )) : <div className="column-empty">{schemaMessage}</div>}
        </div>
      </aside>
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
          <input className="text-input resource-name-input" value={data.resourceName || ""} onChange={(event) => onChange({ ...data, resourceName: event.target.value })} placeholder={`${kind}_name`} />
        </label>
      )}
      {write && (
        <>
          <label className="field-label">
            Operation
            <select value={operation} onChange={(event) => onChange({ ...data, operation: event.target.value })}>
              <option value="append">Append input DataFrame</option>
              <option value="delete">Delete matching rows</option>
            </select>
          </label>
          {operation === "delete" && (
            <label className="field-label">
              pandas query condition
              <textarea rows={4} value={data.condition || ""} onChange={(event) => onChange({ ...data, condition: event.target.value })} placeholder={"status == 'DONE' and amount > 0"} />
            </label>
          )}
          <p className="muted">{operation === "append" ? "Append requires exactly one input DataFrame." : "Delete accepts one optional input DataFrame and passes it through."}</p>
        </>
      )}
      </div>
    </div>
  );
}
