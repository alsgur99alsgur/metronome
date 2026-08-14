import { useRef, useState } from "react";
import { coerceVariableValue, variableInputType, variableInputValue } from "./variableTypes";
import { useErrorDialog } from "../errors/ErrorDialog";

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
  showInputParameters = true,
  inputParametersDisabled = false,
  onRun,
  onCancel,
}) {
  const { showError } = useErrorDialog();
  const [draftValues, setDraftValues] = useState(values || {});
  const draftValuesRef = useRef(values || {});

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

  const run = () => {
    try {
      if (showInputParameters) {
        (inputVariables || []).forEach((item) => {
          const name = normalizeVariableName(item.name);
          coerceVariableValue(draftValuesRef.current[name], item.type, name);
        });
      }
      onRun(showInputParameters ? draftValuesRef.current : null);
    } catch (runError) {
      showError(runError);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="variable-dialog compact-dialog" role="dialog" aria-modal="true">
        <div className="dialog-header">
          <div>
            <div className="eyebrow">Run</div>
            <h3>Run Options</h3>
          </div>
          <button className="icon-button" onClick={onCancel} title="Close">
            x
          </button>
        </div>

        {showInputParameters && (inputVariables || []).length > 0 && (
          <div className="dialog-section-title run-options-section-title">Input Parameters</div>
        )}
        {showInputParameters && <div className="variable-list">
          {(inputVariables || []).map((item) => {
            const name = normalizeVariableName(item.name);
            const historyId = `history-${name.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
            return (
              <label className="run-param-row" key={name}>
                <span>{name}</span>
                <input
                  className="text-input"
                  type={variableInputType(item.type)}
                  list={historyId}
                  value={variableInputValue(draftValues[name], item.type)}
                  disabled={inputParametersDisabled}
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
        </div>}

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
