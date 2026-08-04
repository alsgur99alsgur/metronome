import { useEffect, useRef, useState } from "react";

const safeName = (value) => {
  const safe = (value || "task").replace(/\W+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) return "task";
  return /^\d/.test(safe) ? `task_${safe}` : safe;
};

const normalizeVariableName = (value) => {
  const name = String(value || "").trim().replace(/^\$+/, "");
  return name ? `$${safeName(name)}` : "$var";
};

export default function RunParamsDialog({
  inputVariables,
  values,
  history,
  onRun,
  onCancel,
}) {
  const [draftValues, setDraftValues] = useState(values || {});
  const draftValuesRef = useRef(values || {});

  useEffect(() => {
    const nextValues = values || {};
    draftValuesRef.current = nextValues;
    setDraftValues(nextValues);
  }, [values]);

  const updateValue = (name, value) => {
    setDraftValues((current) => {
      const nextValues = {
        ...current,
        [name]: value,
      };
      draftValuesRef.current = nextValues;
      return nextValues;
    });
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="variable-dialog compact-dialog" role="dialog" aria-modal="true">
        <div className="dialog-header">
          <div>
            <div className="eyebrow">Run</div>
            <h3>Input Parameters</h3>
          </div>
          <button className="icon-button" onClick={onCancel} title="Close">
            x
          </button>
        </div>

        <div className="variable-list">
          {(inputVariables || []).map((item) => {
            const name = normalizeVariableName(item.name);
            const historyId = `history-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
            return (
              <label className="run-param-row" key={name}>
                <span>{name}</span>
                <input
                  className="text-input"
                  list={historyId}
                  value={draftValues[name] ?? ""}
                  onChange={(event) => updateValue(name, event.target.value)}
                />
                <datalist id={historyId}>
                  {(history?.[name] || []).map((value) => (
                    <option value={value} key={value} />
                  ))}
                </datalist>
              </label>
            );
          })}
        </div>

        <div className="editor-actions">
          <div className="action-spacer" />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary-button" onClick={() => onRun(draftValuesRef.current)}>
            Run
          </button>
        </div>
      </div>
    </div>
  );
}
