import { useEffect, useRef, useState } from "react";
import { coerceVariableValue, variableInputType, variableInputValue } from "./variableTypes";

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
  const [error, setError] = useState("");
  const draftValuesRef = useRef(values || {});

  useEffect(() => {
    const nextValues = values || {};
    draftValuesRef.current = nextValues;
    setDraftValues(nextValues);
  }, [values]);

  const updateValue = (name, value) => {
    setError("");
    setDraftValues((current) => {
      const nextValues = {
        ...current,
        [name]: value,
      };
      draftValuesRef.current = nextValues;
      return nextValues;
    });
  };

  const run = () => {
    try {
      (inputVariables || []).forEach((item) => {
        const name = normalizeVariableName(item.name);
        coerceVariableValue(draftValuesRef.current[name], item.type, name);
      });
      onRun(draftValuesRef.current);
    } catch (runError) {
      setError(runError.message);
    }
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
                  type={variableInputType(item.type)}
                  step={item.type === "datetime" ? "1" : undefined}
                  list={historyId}
                  value={variableInputValue(draftValues[name], item.type)}
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
        {error && <div className="error-text inline-error">{error}</div>}

        <div className="editor-actions">
          <div className="action-spacer" />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary-button" onClick={run}>
            Run
          </button>
        </div>
      </div>
    </div>
  );
}
