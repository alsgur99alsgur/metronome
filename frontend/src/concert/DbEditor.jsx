import { useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";

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
  const [activeInputId, setActiveInputId] = useState(null);
  const activeInput = inputDataframes.find((input) => input.id === activeInputId) || inputDataframes[0] || null;

  useEffect(() => {
    if (!inputDataframes.length) {
      setActiveInputId(null);
      return;
    }
    if (!inputDataframes.some((input) => input.id === activeInputId)) {
      setActiveInputId(inputDataframes[0].id);
    }
  }, [activeInputId, inputDataframes]);

  return (
    <aside className="column-side-panel">
      <div className="column-title">Input Columns</div>
      {inputDataframes.length ? (
        <>
          <div className="python-input-tabs">
            {inputDataframes.map((input) => (
              <button
                className={`python-input-tab ${activeInput?.id === input.id ? "active" : ""}`}
                key={input.id}
                onClick={() => setActiveInputId(input.id)}
                title={input.name}
              >
                {input.name}
              </button>
            ))}
          </div>
          <ColumnList
            columns={activeInput?.columns || []}
            emptyText={activeInput?.status === "not_run" ? "Run parent node to inspect columns." : "No DataFrame columns."}
          />
        </>
      ) : (
        <ColumnList columns={[]} emptyText="No connected inputs." />
      )}
    </aside>
  );
}

function OutputColumnsPanel({ columns = [], error, emptyText }) {
  return (
    <aside className="column-side-panel">
      <div className="column-title">Output Columns</div>
      {error ? <div className="column-empty">{error}</div> : <ColumnList columns={columns} emptyText={emptyText} />}
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
  describeEnabled = true,
  apiBaseUrl = "http://localhost:8000",
}) {
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  const decorationIdsRef = useRef([]);
  const [editorReady, setEditorReady] = useState(0);
  const [connections, setConnections] = useState([]);
  const [columnError, setColumnError] = useState(null);

  useEffect(() => {
    let isMounted = true;

    const loadConnections = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/connections`);
        if (!response.ok) return;
        const body = await response.json();
        const names = (body.connections || []).map((connection) => connection.name).filter(Boolean);
        if (isMounted) setConnections([...new Set(names)]);
      } catch {
        if (isMounted) setConnections([]);
      }
    };

    loadConnections();
    return () => {
      isMounted = false;
    };
  }, [apiBaseUrl]);

  useEffect(() => {
    if (!describeEnabled) {
      setColumnError(null);
      return undefined;
    }

    let isMounted = true;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/db-read/describe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            connection: editData.connection || "",
            sql: editData.sql || "",
          }),
        });
        if (!response.ok) return;
        const body = await response.json();
        if (!isMounted) return;
        const nextColumns = body.columns || [];
        setColumnError(body.error || null);
        setEditData((current) => ({
          ...current,
          outputColumns: nextColumns,
        }));
      } catch (error) {
        if (!isMounted) return;
        setColumnError(error.message);
      }
    }, 350);

    return () => {
      isMounted = false;
      window.clearTimeout(timeout);
    };
  }, [apiBaseUrl, describeEnabled, editData.connection, editData.sql, setEditData]);

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
          }));
        }}
      >
        <option value="">Select</option>
        {connections.map((connection) => (
          <option value={connection} key={connection}>
            {connection}
          </option>
        ))}
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
              fontSize: 14,
              minimap: { enabled: false },
              automaticLayout: true,
            }}
            value={editData.sql || ""}
            onChange={(value) => {
              setEditData((current) => ({
                ...current,
                sql: value,
              }));
            }}
          />
        </div>
        <OutputColumnsPanel columns={outputColumns} error={columnError} emptyText={outputMessage} />
      </div>
    </div>
  );
}
