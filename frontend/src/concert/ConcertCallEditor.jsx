import { useEffect, useState } from "react";

import ConcertListPanel from "./ConcertListPanel";
import { variableInputType, variableInputValue } from "./variableTypes";
import { concertBaseName, validateConcertPath } from "./nameValidation";
import { useErrorDialog } from "../errors/ErrorDialog";

const safeName = (value) => {
  const safe = (value || "task").replace(/\W+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) return "task";
  return /^\d/.test(safe) ? `task_${safe}` : safe;
};

const safeConcertPathName = validateConcertPath;

const normalizeVariableName = (value) => {
  const name = String(value || "").trim().replace(/^\$+/, "");
  return name ? `$${safeName(name)}` : "$var";
};

const inputVariableKey = (item) =>
  normalizeVariableName(item?.name || "").replace(/^\$/, "");

const stringifyParamValue = (value) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const inputVariablesToParamValues = (inputVariables = [], currentParams = {}) =>
  Object.fromEntries(
    inputVariables
      .map((item) => {
        const key = inputVariableKey(item);
        if (!key || key === "var") return null;
        return [
          key,
          stringifyParamValue(
            currentParams[key] ?? item.defaultValue ?? "",
          ),
        ];
      })
      .filter(Boolean),
  );

function ColumnList({ columns = [], emptyText }) {
  return (
    <div className="column-list">
      {columns.length ? (
        columns.map((column) => (
          <div className="column-row" key={`${column.name}-${column.type}`}>
            <span className="column-name">{column.name}</span>
            <span className="column-type">{column.type}</span>
          </div>
        ))
      ) : (
        <div className="column-empty">{emptyText}</div>
      )}
    </div>
  );
}

function InputColumnsPanel({ inputDataframes = [] }) {
  const inputColumns = inputDataframes[0]?.columns || [];
  const inputMessage = inputDataframes[0]?.status === "not_run"
    ? "Run parent node to inspect columns."
    : "No connected input DataFrame.";

  return (
    <aside className="column-side-panel">
      <div className="column-title">Input Columns</div>
      <ColumnList columns={inputColumns} emptyText={inputMessage} />
    </aside>
  );
}

function OutputColumnsPanel({ outputColumns = [], outputMessage }) {
  return (
    <aside className="column-side-panel">
      <div className="column-title">Output Columns</div>
      <ColumnList columns={outputColumns} emptyText={outputMessage} />
    </aside>
  );
}

function ConcertPickerDialog({ apiBaseUrl, onSelect, onClose }) {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  return (
    <div className="concert-picker-backdrop" onClick={onClose}>
      <section className="concert-picker" onClick={(event) => event.stopPropagation()}>
        <div className="concert-picker-header">
          <h2>Select Concert</h2>
          <button className="icon-button" onClick={onClose} title="Close">
            x
          </button>
        </div>
        <ConcertListPanel apiBaseUrl={apiBaseUrl} fixedSource="playings" onOpen={onSelect} />
      </section>
    </div>
  );
}

export default function ConcertCallEditor({
  editData,
  setEditData,
  apiBaseUrl = "http://localhost:8000",
  inputDataframes = [],
  outputColumns = [],
  outputMessage = "Run this node to inspect Concert output columns.",
}) {
  const { showError } = useErrorDialog();
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  const loadConcertInputsByName = async (concertName) => {
    let nextConcertName;
    try {
      nextConcertName = safeConcertPathName(concertName);
    } catch (error) {
      showError(error);
      setEditData((current) => ({
        ...current,
        concertLoadError: error.message,
        concertInputsLoading: false,
      }));
      return;
    }

    let response;
    try {
      response = await fetch(
        `${apiBaseUrl}/playings-by-name/${encodeURIComponent(concertBaseName(nextConcertName))}`,
      );
    } catch (error) {
      showError(`Load Concert failed: ${error.message}`);
      setEditData((current) => ({
        ...current,
        concertLoadError: `Load Concert failed: ${error.message}`,
        concertInputsLoading: false,
      }));
      return;
    }
    if (!response.ok) {
      showError(
        response.status === 404
          ? `Concert not found in backend: ${nextConcertName}`
          : `Load Concert failed: ${response.status}`,
      );
      setEditData((current) => ({
        ...current,
        concertLoadError:
          response.status === 404
            ? `Concert not found in backend: ${nextConcertName}`
            : `Load Concert failed: ${response.status}`,
        calledConcertInputVariables: [],
        inputParamValues: {},
        inputParams: {},
        concertInputsLoading: false,
      }));
      return;
    }

    const payload = await response.json();
    const nextInputVariables = payload.inputVariables;
    setEditData((current) => ({
      ...current,
      concertId: payload.concertId,
      concertName: concertBaseName(payload.name),
      concertLoadError: undefined,
      calledConcertInputVariables: nextInputVariables,
      concertInputsLoading: false,
      inputParamValues: inputVariablesToParamValues(
        nextInputVariables,
        current.inputParamValues || current.inputParams || {},
      ),
    }));
  };

  const selectConcert = async (concertName, concert) => {
    setEditData((current) => ({
      ...current,
      concertId: concert.concertId,
      concertName: concertBaseName(concertName),
      concertLoadError: undefined,
      calledConcertInputVariables: [],
      inputParamValues: {},
      inputParams: {},
      concertInputsLoading: true,
    }));
    setIsPickerOpen(false);
    await loadConcertInputsByName(concertName);
  };

  const openPicker = () => setIsPickerOpen(true);

  return (
    <div className="concert-call-editor-grid">
      <InputColumnsPanel inputDataframes={inputDataframes} />
      <div className="simple-editor">
        <label className="field-label">Concert</label>
        <div className="concert-call-picker">
          <input
            className="text-input"
            value={editData.concertName || ""}
            readOnly
          />
          <button type="button" onClick={openPicker}>
            Browse
          </button>
        </div>
        <label className="field-label">Input Parameters</label>
        {editData.concertInputsLoading && (
          <p className="muted">Loading Concert input definitions...</p>
        )}
        {(editData.calledConcertInputVariables || []).length === 0 ? (
          <p className="muted">Load a backend Concert to inspect its input fields.</p>
        ) : (
          <div className="concert-call-param-list">
            {(editData.calledConcertInputVariables || []).map((item, index) => {
              const key = inputVariableKey(item);
              return (
                <div className="concert-call-param-row" key={`${key}-${index}`}>
                  <label className="field-label">{normalizeVariableName(item.name)}</label>
                  <input
                    className="text-input"
                    type={variableInputType(item.type)}
                    value={variableInputValue(editData.inputParamValues?.[key], item.type)}
                    placeholder={String(item.defaultValue ?? "")}
                    onChange={(event) =>
                      setEditData((current) => ({
                        ...current,
                        inputParamValues: {
                          ...(current.inputParamValues || {}),
                          [key]: event.target.value,
                        },
                      }))
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
      <OutputColumnsPanel
        outputColumns={outputColumns}
        outputMessage={outputMessage}
      />
      {isPickerOpen && (
        <ConcertPickerDialog
          apiBaseUrl={apiBaseUrl}
          onSelect={selectConcert}
          onClose={() => setIsPickerOpen(false)}
        />
      )}
    </div>
  );
}
