import { useEffect, useState } from "react";
import { VARIABLE_TYPES, coerceVariableValue, currentDateTimeInputValue, variableInputType, variableInputValue } from "./variableTypes";

const safeName = (value) => {
  const safe = (value || "task").replace(/\W+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) return "task";
  return /^\d/.test(safe) ? `task_${safe}` : safe;
};

const normalizeVariableName = (value) => {
  const name = String(value || "").trim().replace(/^\$+/, "");
  return name ? `$${safeName(name)}` : "$var";
};

export default function VariablesDialog({
  globalVariables,
  inputVariables,
  onSave,
  onCancel,
}) {
  const [draftGlobalVariables, setDraftGlobalVariables] = useState(() =>
    (globalVariables || []).map((item) => ({ ...item, type: item.type || "string" })),
  );
  const [draftInputVariables, setDraftInputVariables] = useState(() =>
    (inputVariables || []).map((item) => ({ ...item, type: item.type || "string" })),
  );
  const [error, setError] = useState("");

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const updateGlobal = (index, patch) => {
    setDraftGlobalVariables((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  };
  const updateInput = (index, patch) => {
    setDraftInputVariables((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  };

  const save = () => {
    const variables = [...draftGlobalVariables, ...draftInputVariables];
    try {
      draftGlobalVariables.forEach((item) => coerceVariableValue(item.value, item.type, normalizeVariableName(item.name)));
      draftInputVariables.forEach((item) => {
        if (String(item.defaultValue ?? "").trim() !== "") {
          coerceVariableValue(item.defaultValue, item.type, normalizeVariableName(item.name));
        }
      });
    } catch (saveError) {
      setError(saveError.message);
      return;
    }
    onSave({
      globalVariables: draftGlobalVariables.map((item) => ({
        ...item,
        name: normalizeVariableName(item.name),
      })),
      inputVariables: draftInputVariables.map((item) => ({
        ...item,
        name: normalizeVariableName(item.name),
      })),
    });
  };

  return (
    <div className="editor-modal-backdrop" role="presentation">
      <aside className="editor-panel variable-editor-panel" role="dialog" aria-modal="true">
        <div className="editor-header">
          <div>
            <div className="eyebrow">Concert</div>
            <h2>Edit Variables</h2>
          </div>
        </div>

        <div className="editor-body variable-sections">
          <section>
            <div className="variable-section-header">
              <div className="dialog-section-title">Input Variables</div>
              <button
                onClick={() =>
                  setDraftInputVariables((current) => [
                    ...current,
                    { name: "$input", type: "string", defaultValue: "" },
                  ])
                }
              >
                Add Input
              </button>
            </div>
            {draftInputVariables.map((item, index) => (
              <div className="variable-row" key={`input-${index}`}>
                <input
                  className="text-input"
                  value={item.name}
                  onChange={(event) =>
                    updateInput(index, { name: event.target.value })
                  }
                  onBlur={(event) =>
                    updateInput(index, {
                      name: normalizeVariableName(event.target.value),
                    })
                  }
                  placeholder="$run_id"
                />
                <select className="text-input variable-type-select" value={item.type} onChange={(event) => { const type = event.target.value; updateInput(index, { type, defaultValue: type === "datetime" ? currentDateTimeInputValue() : "" }); }}>
                  {VARIABLE_TYPES.map((type) => <option value={type} key={type}>{type}</option>)}
                </select>
                <input
                  className="text-input"
                  type={variableInputType(item.type)}
                  step={item.type === "datetime" ? "1" : undefined}
                  value={variableInputValue(item.defaultValue, item.type)}
                  onChange={(event) =>
                    updateInput(index, { defaultValue: event.target.value })
                  }
                  placeholder="default"
                />
                <button
                  onClick={() =>
                    setDraftInputVariables((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </section>

          <section>
            <div className="variable-section-header">
              <div className="dialog-section-title">Global Variables</div>
              <button
                onClick={() =>
                  setDraftGlobalVariables((current) => [
                    ...current,
                    { name: "$var", type: "string", value: "" },
                  ])
                }
              >
                Add Global
              </button>
            </div>
            {draftGlobalVariables.map((item, index) => (
              <div className="variable-row" key={`global-${index}`}>
                <input
                  className="text-input"
                  value={item.name}
                  onChange={(event) =>
                    updateGlobal(index, { name: event.target.value })
                  }
                  onBlur={(event) =>
                    updateGlobal(index, {
                      name: normalizeVariableName(event.target.value),
                    })
                  }
                  placeholder="$base_date"
                />
                <select className="text-input variable-type-select" value={item.type} onChange={(event) => { const type = event.target.value; updateGlobal(index, { type, value: type === "datetime" ? currentDateTimeInputValue() : "" }); }}>
                  {VARIABLE_TYPES.map((type) => <option value={type} key={type}>{type}</option>)}
                </select>
                <input
                  className="text-input"
                  type={variableInputType(item.type)}
                  step={item.type === "datetime" ? "1" : undefined}
                  value={variableInputValue(item.value, item.type)}
                  onChange={(event) =>
                    updateGlobal(index, { value: event.target.value })
                  }
                  placeholder="value"
                />
                <button
                  onClick={() =>
                    setDraftGlobalVariables((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </section>
        </div>

        {error && <div className="error-text inline-error">{error}</div>}

        <div className="editor-actions">
          <div className="action-spacer" />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary-button" disabled={[...draftGlobalVariables, ...draftInputVariables].some((item) => !VARIABLE_TYPES.includes(item.type))} onClick={save}>
            Save
          </button>
        </div>
      </aside>
    </div>
  );
}
