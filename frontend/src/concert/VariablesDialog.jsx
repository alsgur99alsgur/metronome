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
  onChangeGlobal,
  onChangeInput,
  onClose,
}) {
  const updateGlobal = (index, patch) => {
    onChangeGlobal((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  };
  const updateInput = (index, patch) => {
    onChangeInput((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...patch } : item,
      ),
    );
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="variable-dialog" role="dialog" aria-modal="true">
        <div className="dialog-header">
          <div>
            <div className="eyebrow">Concert</div>
            <h3>Variables</h3>
          </div>
          <button className="icon-button" onClick={onClose} title="Close">
            x
          </button>
        </div>

        <div className="variable-sections">
          <section>
            <div className="variable-section-header">
              <div className="dialog-section-title">Input Variables</div>
              <button
                onClick={() =>
                  onChangeInput((current) => [
                    ...current,
                    { name: "$input", defaultValue: "" },
                  ])
                }
              >
                Add Input
              </button>
            </div>
            {(inputVariables || []).map((item, index) => (
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
                    onChangeInput((current) =>
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
                  onChangeGlobal((current) => [
                    ...current,
                    { name: "$var", value: "" },
                  ])
                }
              >
                Add Global
              </button>
            </div>
            {(globalVariables || []).map((item, index) => (
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
                    onChangeGlobal((current) =>
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
          <button className="primary-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
