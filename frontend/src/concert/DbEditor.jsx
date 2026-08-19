import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import OutputColumnsTitle from "./OutputColumnsTitle";

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
  const activeInput = inputDataframes[0] || null;

  return (
    <aside className="column-side-panel">
      <div className="column-title">Input Columns</div>
      {inputDataframes.length ? (
        <ColumnList
          columns={activeInput?.columns || []}
          emptyText={activeInput?.status === "not_run" ? "Run parent node to inspect columns." : "No DataFrame columns."}
        />
      ) : (
        <ColumnList columns={[]} emptyText="No connected inputs." />
      )}
    </aside>
  );
}

function OutputColumnsPanel({ columns = [], emptyText, error, onRefresh, refreshing }) {
  return (
    <aside className="column-side-panel">
      <OutputColumnsTitle onRefresh={onRefresh} refreshing={refreshing} />
      {error && <div className="column-schema-error">{error}</div>}
      <ColumnList columns={columns} emptyText={emptyText} />
    </aside>
  );
}

export default function DbEditor({
  editData,
  setEditData,
  searchHighlight,
  inputDataframes = [],
  outputColumns = [],
  outputMessage = "No result columns.",
  outputError = "",
  describeEnabled = true,
  apiBaseUrl = "http://localhost:8000",
  globalVariables = [],
  inputVariables = [],
  onRefreshOutputColumns,
  refreshingOutputColumns = false,
}) {
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const decorationIdsRef = useRef([]);
  const [editorReady, setEditorReady] = useState(0);
  const [connections, setConnections] = useState([]);

  useEffect(() => {
    let isMounted = true;

    const loadConnections = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/connections`);
        if (!response.ok) return;
        const body = await response.json();
        const names = (body.connections || []).map((connection) => connection.name).filter(Boolean);
        if (isMounted) {
          setConnections([...new Set(names)]);
        }
      } catch {
        if (isMounted) setConnections([]);
      }
    };

    loadConnections();
    return () => {
      isMounted = false;
    };
  }, [apiBaseUrl, setEditData]);

  useEffect(() => {
    if (!describeEnabled) return undefined;
    if (!editData.connection) return undefined;

    let isMounted = true;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/db-read/describe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connection: editData.connection || "",
            sql: editData.sql || "",
            globalVariables,
            inputVariables,
          }),
        });
        if (!response.ok) {
          const message = await response.text();
          if (isMounted) {
            setEditData((current) => ({
              ...current,
              outputColumns: [],
              dbReadSchema: null,
              schemaError: message || `Schema inference failed (${response.status}).`,
            }));
          }
          return;
        }
        const body = await response.json();
        if (!isMounted) return;
        if (body.error) {
          setEditData((current) => ({
            ...current,
            outputColumns: [],
            dbReadSchema: null,
            schemaError: body.error,
          }));
          return;
        }
        const nextColumns = body.columns || [];
        setEditData((current) => ({
          ...current,
          outputColumns: nextColumns,
          dbReadSchema: { columns: nextColumns },
          schemaError: undefined,
        }));
      } catch (error) {
        if (isMounted) {
          setEditData((current) => ({
            ...current,
            outputColumns: [],
            dbReadSchema: null,
            schemaError: `Schema inference failed: ${error.message}`,
          }));
        }
      }
    }, 350);

    return () => {
      isMounted = false;
      window.clearTimeout(timeout);
    };
  }, [
    apiBaseUrl,
    describeEnabled,
    editData.connection,
    editData.sql,
    globalVariables,
    inputVariables,
    setEditData,
  ]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    decorationIdsRef.current = editor.deltaDecorations(decorationIdsRef.current, []);
    if (!searchHighlight || searchHighlight.field !== "sql") return;

    const range = new monaco.Range(
      searchHighlight.lineNumber,
      searchHighlight.startColumn,
      searchHighlight.lineNumber,
      searchHighlight.endColumn,
    );
    decorationIdsRef.current = editor.deltaDecorations([], [
      {
        range,
        options: {
          className: "search-editor-highlight",
          inlineClassName: "search-editor-inline-highlight",
        },
      },
    ]);
    editor.revealLineInCenter(searchHighlight.lineNumber);
    editor.setSelection(range);
    editor.focus();
  }, [editorReady, searchHighlight]);

  return (
    <div className="node-form-editor">
      <label className="field-label">Connection</label>
      <select
        className="text-input"
        value={editData.connection || ""}
        onChange={(event) => {
          setEditData((current) => ({
            ...current,
            connection: event.target.value,
            schemaError: undefined,
          }));
        }}
      >
        <option value="">Select</option>
        {connections.map((connection) => (
          <option value={connection} key={connection}>
            {connection}
          </option>
        ))}
        {(inputVariables || []).length > 0 && (
          <optgroup label="Input Variables">
            {inputVariables.map((variable) => (
              <option value={variable.name} key={`input-${variable.name}`}>
                {variable.name} ({String(variable.defaultValue ?? "")})
              </option>
            ))}
          </optgroup>
        )}
        {(globalVariables || []).length > 0 && (
          <optgroup label="Global Variables">
            {globalVariables.map((variable) => (
              <option value={variable.name} key={`global-${variable.name}`}>
                {variable.name} ({String(variable.value ?? "")})
              </option>
            ))}
          </optgroup>
        )}
      </select>

      <label className="field-label">SQL</label>
      <div className="node-editor-grid">
        <InputColumnsPanel inputDataframes={inputDataframes} />
        <div className="monaco-box">
          <Editor
            height="100%"
            defaultLanguage="sql"
            theme="vs-light"
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              monacoRef.current = monaco;
              setEditorReady((current) => current + 1);
            }}
            options={{
              fontSize: 12,
              minimap: { enabled: false },
              automaticLayout: true,
            }}
            value={editData.sql || ""}
            onChange={(value) => {
              setEditData((current) => ({
                ...current,
                sql: value,
                schemaError: undefined,
              }));
            }}
          />
        </div>
        <OutputColumnsPanel
          columns={outputColumns}
          emptyText={outputMessage}
          error={outputError}
          onRefresh={onRefreshOutputColumns}
          refreshing={refreshingOutputColumns}
        />
      </div>
    </div>
  );
}
