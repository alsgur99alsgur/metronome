import { useEffect, useState } from "react";

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
    (globalVariables || []).map((item) => ({ ...item })),
  );
  const [draftInputVariables, setDraftInputVariables] = useState(() =>
    (inputVariables || []).map((item) => ({ ...item })),
  );

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
                    { name: "$input", defaultValue: "" },
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
                <input
                  className="text-input"
                  value={item.defaultValue ?? ""}
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
                    { name: "$var", value: "" },
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
                <input
                  className="text-input"
                  value={item.value ?? ""}
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

        <div className="editor-actions">
          <div className="action-spacer" />
          <button onClick={onCancel}>Cancel</button>
          <button className="primary-button" onClick={save}>
            Save
          </button>
        </div>
      </aside>
    </div>
  );
}
