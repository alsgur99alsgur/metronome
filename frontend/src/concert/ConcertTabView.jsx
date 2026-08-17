import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import ReactFlow, {
  Background,
  ConnectionMode,
  Controls,
  MarkerType,
  PanOnScrollMode,
  SelectionMode,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
} from "reactflow";

import "reactflow/dist/style.css";
import "./Flow.css";

import CenterEdge from "./CenterEdge";
import ConcertCallEditor from "./ConcertCallEditor";
import ConcertNodeContextMenu from "./ConcertNodeContextMenu";
import ConcertOutputPanel from "./ConcertOutputPanel";
import ConcertSearch from "./ConcertSearch";
import { openDataWindow } from "./DataViewerWindow";
import InputEditor from "./InputEditor";
import NodePalette from "./NodePalette";
import OutputEditor from "./OutputEditor";
import OplEditor, { buildPyomoCode } from "./OplEditor";
import DbEditor from "./DbEditor";
import ResourceEditor from "./ResourceEditor";
import PythonEditor from "./PythonEditor";
import { pythonTemplate } from "./pythonTemplate";
import TextEditor from "./TextEditor";
import TextNodeResizeContext from "./TextNodeResizeContext";
import ReplayDialog from "./ReplayDialog";
import RunCacheDialog from "./RunCacheDialog";
import RunParamsDialog from "./RunParamsDialog";
import RunningDialog from "./RunningDialog";
import SaveChangesDialog from "./SaveChangesDialog";
import VariablesDialog from "./VariablesDialog";
import { coerceVariableValue } from "./variableTypes";
import { nodeTypes } from "./nodeTypes";
import { runTargetNodes, runValidationMessage, validateRunNodes } from "./nodeRunValidation";
import { concertBaseName, validateCacheName, validateConcertName, validateConcertPath, validateNodeName } from "./nameValidation";
import { useErrorDialog } from "../errors/ErrorDialog";

const makeId = () => crypto.randomUUID();
let lastNodeIdBase = "";
let lastNodeIdCount = 0;

const responseErrorMessage = async (response) => {
  const text = await response.text();
  if (!text) return `Request failed (${response.status}).`;
  try {
    const body = JSON.parse(text);
    return typeof body?.detail === "string" ? body.detail : text;
  } catch {
    return text;
  }
};

const padNumber = (value, size) => String(value).padStart(size, "0");

const makeNodeId = (type) => {
  const now = new Date();
  const microPart = Math.floor((performance.now() % 1) * 1000);
  const base = [
    now.getFullYear(),
    padNumber(now.getMonth() + 1, 2),
    padNumber(now.getDate(), 2),
    "_",
    padNumber(now.getHours(), 2),
    padNumber(now.getMinutes(), 2),
    padNumber(now.getSeconds(), 2),
    "_",
    padNumber(now.getMilliseconds(), 3),
    padNumber(microPart, 3),
    "_",
    safeName(type),
  ].join("");
  if (base === lastNodeIdBase) {
    lastNodeIdCount += 1;
    return `${base}_${lastNodeIdCount}`;
  }
  lastNodeIdBase = base;
  lastNodeIdCount = 0;
  return base;
};

const makeUniqueNodeId = (type, usedIds) => {
  let nextId = makeNodeId(type);
  while (usedIds.has(nextId)) {
    nextId = makeNodeId(type);
  }
  usedIds.add(nextId);
  return nextId;
};

const safeName = (value) => {
  const safe = (value || "task").replace(/\W+/g, "_").replace(/^_+|_+$/g, "");
  if (!safe) return "task";
  return /^\d/.test(safe) ? `task_${safe}` : safe;
};

const safeConcertPathName = validateConcertPath;

const edgeId = (source, target) => `${source}-${target}`;

const normalizeEdge = (edge) => ({
  ...edge,
  id: edgeId(edge.source, edge.target),
  type: "center",
  markerEnd: { type: MarkerType.ArrowClosed },
});

const cloneGraph = ({ nodes, edges }) => {
  if (typeof structuredClone === "function") {
    return structuredClone({ nodes, edges });
  }
  return JSON.parse(JSON.stringify({ nodes, edges }));
};

const runtimeNodeDataKeys = [
  "status",
  "runRows",
  "runDurationMs",
  "runLoopIterations",
  "outputColumns",
  "inputParamValues",
  "concertLoadError",
  "schemaError",
  "isConnectMode",
];

const graphForHistory = (graph) => {
  const snapshot = cloneGraph(graph);
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => {
      const data = { ...(node.data || {}) };
      runtimeNodeDataKeys.forEach((key) => {
        delete data[key];
      });
      return { ...node, selected: false, data };
    }),
  };
};

const stateForHistory = (graph, globalVariables, inputVariables) => ({
  graph: graphForHistory(graph),
  globalVariables: cloneValue(globalVariables),
  inputVariables: cloneValue(inputVariables),
});

const restoreCurrentRuntimeData = (snapshotNodes, currentNodes) => {
  const currentById = new Map(currentNodes.map((node) => [node.id, node]));
  return snapshotNodes.map((node) => {
    const currentData = currentById.get(node.id)?.data;
    const data = { ...(node.data || {}) };
    runtimeNodeDataKeys.forEach((key) => {
      if (currentData && Object.hasOwn(currentData, key)) {
        data[key] = currentData[key];
      } else {
        delete data[key];
      }
    });
    if (!Object.hasOwn(data, "status")) data.status = "skipped";
    return { ...node, data };
  });
};

const cloneValue = (value) => {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
};

const createBlankTab = () => ({
  id: makeId(),
  concertId: crypto.randomUUID(),
  lastCommitId: null,
  commitId: null,
  concertName: "untitled_concert",
  concertFileLabel: "untitled_concert",
  concertFileHandle: null,
  version: "",
  nodes: [],
  edges: [],
  globalVariables: [],
  inputVariables: [],
  runParamValues: {},
  run: null,
  activeRunId: null,
  lastRunId: null,
  replays: [],
  selectedReplayId: "",
  undoStack: [],
  redoStack: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  isSearchVisible: true,
  searchHeight: 220,
  searchInputTerm: "",
  searchSubmittedTerm: "",
  isOutputVisible: true,
  outputHeight: 220,
  activeBottomPanel: "output",
  isDirty: false,
});

const isSameNodePair = (edge, source, target) =>
  (edge.source === source && edge.target === target) ||
  (edge.source === target && edge.target === source);

const singleParentTargetTypes = new Set(["concert", "concertOutput", "dbRead", "dbWrite", "cacheWrite", "loopIn", "loopOut"]);
const noParentTargetTypes = new Set(["concertInput"]);
const noChildSourceTypes = new Set(["concertOutput"]);
const supportedNodeTypes = new Set([
  "dbRead", "dbWrite", "python", "opl", "concert", "concertInput",
  "concertOutput", "cacheRead", "cacheWrite", "loopIn", "loopOut", "text",
]);

const normalizeColumnMetadata = (columns = []) =>
  columns.map((column) =>
    typeof column === "string"
      ? { name: column, type: "unknown" }
      : { name: column.name, type: column.type || column.dtype || "unknown" },
  );

const isMonacoSuggestVisible = () =>
  Boolean(document.querySelector(".monaco-editor .suggest-widget.visible"));

const isTextEditingTarget = (target) => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      'input, textarea, select, [contenteditable="true"], .monaco-editor',
    ),
  );
};

const isNodeInOutputPanel = (node) => {
  const element =
    node instanceof HTMLElement
      ? node
      : node?.parentElement instanceof HTMLElement
        ? node.parentElement
        : null;
  return Boolean(element?.closest(".concert-output"));
};

const hasOutputTextSelection = () => {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  return (
    isNodeInOutputPanel(selection.anchorNode) ||
    isNodeInOutputPanel(selection.focusNode)
  );
};

const hasPyomoCodeTextSelection = () => {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  const isInsideCode = (node) => {
    const element =
      node instanceof HTMLElement
        ? node
        : node?.parentElement instanceof HTMLElement
          ? node.parentElement
          : null;
    return Boolean(element?.closest(".opl-code-dialog pre"));
  };
  return isInsideCode(selection.anchorNode) || isInsideCode(selection.focusNode);
};

const getEditableSnapshot = (type, data = {}) => {
  if (type === "text") {
    return {
      name: data.name || "",
      text: data.text || "",
      backgroundColor: data.backgroundColor || "#fffde7",
      textColor: data.textColor || "#1f2937",
      fontSize: data.fontSize || 16,
    };
  }
  if (type === "dbRead") {
    return {
      name: data.name || "",
      connection: data.connection || "",
      sql: data.sql || "",
    };
  }
  if (type === "python") {
    return {
      name: data.name || "",
      code: data.code || "",
    };
  }
  if (type === "opl") {
    return {
      name: data.name || "",
      sets: data.sets || [],
      params: data.params || [],
      variables: data.variables || [],
      expressions: data.expressions || [],
      objectiveSense: data.objectiveSense || "maximize",
      solver: data.solver || "highs",
      solverTimeoutSeconds: data.solverTimeoutSeconds ?? 60,
      mipGap: data.mipGap ?? 0.01,
    };
  }
  if (type === "dbWrite") {
    return {
      name: data.name || "",
      connection: data.connection || "",
      sql: data.sql || "",
    };
  }
  if (type === "concert") {
    return {
      name: data.name || "",
      concertId: data.concertId || "",
      concertName: data.concertName || "",
      inputParamValues:
        data.inputParamValues ||
        Object.fromEntries(
          Object.entries(data.inputParams || {}).map(([key, value]) => [
            key,
            stringifyParamValue(value),
          ]),
        ),
      calledConcertInputVariables: data.calledConcertInputVariables || [],
    };
  }
  if (type === "concertInput") {
    return {
      name: data.name || "",
      inputIndex: data.inputIndex || 0,
    };
  }
  if (["cacheRead", "cacheWrite"].includes(type)) {
    return {
      name: data.name || "",
      scope: data.scope || "stage",
      resourceName: data.resourceName || "",
      operation: data.operation || (type.endsWith("Write") ? "append" : undefined),
      condition: data.condition || "",
    };
  }
  if (type === "loopIn") {
    return {
      name: data.name || "",
      iterationMode: data.iterationMode || "allRows",
      groupByColumns: data.groupByColumns || "",
    };
  }
  if (type === "loopOut") {
    return {
      name: data.name || "",
      maxIterations: data.maxIterations ?? "0",
      stopConditions: data.stopConditions || [],
    };
  }
  return { name: data.name || "" };
};

const hasEditorChanges = (node, editData) => {
  if (!node || !editData) return false;
  return (
    JSON.stringify(getEditableSnapshot(node.type, node.data)) !==
    JSON.stringify(getEditableSnapshot(node.type, editData))
  );
};

const edgeTypes = {
  center: CenterEdge,
};

const nodeTypeLabel = (type) => ({ dbRead: "DB Read", dbWrite: "DB Write", opl: "OPL", text: "Text" })[type] || type;

const frontendOnlyNodeTypes = new Set(["text"]);
const edgeZIndex = 1;
const regularNodeZIndex = 2;

const executableGraph = (targetNodes, targetEdges) => {
  const executableNodes = targetNodes.filter(
    (node) => !frontendOnlyNodeTypes.has(node.type),
  );
  const executableNodeIds = new Set(executableNodes.map((node) => node.id));
  return {
    nodes: executableNodes,
    edges: targetEdges.filter(
      (edge) =>
        executableNodeIds.has(edge.source) && executableNodeIds.has(edge.target),
    ),
  };
};

const createNode = (type, index, position) => {
  const name = `${({ dbRead: "db_read", dbWrite: "db_write" })[type] || type}_${index}`;
  const data = { name, status: "skipped" };

  if (type === "dbRead") {
    data.connection = "";
    data.sql = [
      "-- DB Read bind parameters use the same shape with or without input data.",
      '-- With input: df["customer"] -> :customer for each DataFrame row.',
      "-- Without input: Concert params with matching names are used.",
      "select *",
      "from customer_table",
      "where customer = :customer",
    ].join("\n");
  }

  if (type === "python") {
    data.code = pythonTemplate(name);
  }

  if (type === "opl") {
    data.sets = [];
    data.params = [];
    data.variables = [];
    data.expressions = [];
    data.objectiveSense = "maximize";
    data.solver = "highs";
    data.solverTimeoutSeconds = 60;
    data.mipGap = 0.01;
  }

  if (type === "dbWrite") {
    data.connection = "";
    data.sql = [
      "-- DataFrame rows are passed to executemany as bind parameter dictionaries.",
      '-- df["customer"] -> :customer, df["amount"] -> :amount, df["region"] -> :region',
      "insert into target_table (customer, amount, region)",
      "values (:customer, :amount, :region)",
    ].join("\n");
  }

  if (type === "concert") {
    data.concertId = "";
    data.concertName = "";
    data.inputParams = {};
    data.calledConcertInputVariables = [];
  }

  if (type === "concertInput") {
    data.inputIndex = 0;
  }

  if (["cacheRead", "cacheWrite"].includes(type)) {
    data.scope = "stage";
    data.resourceName = "";
    if (type.endsWith("Write")) {
      data.operation = "append";
      data.condition = "";
    }
  }

  if (type === "loopIn") {
    data.iterationMode = "allRows";
    data.groupByColumns = "";
  }

  if (type === "loopOut") {
    data.maxIterations = "0";
    data.stopConditions = [];
  }

  if (type === "text") {
    data.text = "";
    data.backgroundColor = "#fffde7";
    data.textColor = "#1f2937";
    data.fontSize = 16;
  }

  return {
    id: makeNodeId(type),
    type,
    position,
    data,
    ...(type === "text"
      ? { style: { width: 200, height: 200 }, zIndex: 0 }
      : { zIndex: regularNodeZIndex }),
  };
};

const initialNodes = [];
const initialEdges = [];

const getFileNameBase = (fileName) =>
  validateConcertName(String(fileName ?? "").replace(/\.concert$/i, ""));

const normalizeVariableName = (value) => {
  const name = String(value || "")
    .trim()
    .replace(/^\$+/, "");
  return name ? `$${safeName(name)}` : "$var";
};

const stringifyParamValue = (value) => {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const variablePayload = (variables, valueKey = "value") =>
  (variables || [])
    .filter((item) => String(item?.name || "").trim())
    .map((item) => ({
      ...item,
      name: normalizeVariableName(item.name),
      [valueKey]: coerceVariableValue(item[valueKey], item.type, normalizeVariableName(item.name)),
    }));

const typedParamPayload = (values, inputVariables) => {
  const definitions = new Map(
    (inputVariables || []).map((item) => [normalizeVariableName(item.name).replace(/^\$+/, ""), item]),
  );
  return Object.fromEntries(
    Object.entries(values || {}).map(([key, value]) => {
      const normalizedKey = key.replace(/^\$+/, "");
      const definition = definitions.get(normalizedKey);
      if (!definition) throw new Error(`Input variable definition not found: $${normalizedKey}`);
      return [key, coerceVariableValue(value, definition.type, `$${normalizedKey}`)];
    }),
  );
};

const variableInputDefaults = (inputVariables) =>
  Object.fromEntries(
    (inputVariables || []).map((item) => [
      normalizeVariableName(item.name),
      String(item.defaultValue ?? ""),
    ]),
  );

const omitKeys = (value, keys) => Object.fromEntries(
  Object.entries(value || {}).filter(([key]) => !keys.has(key)),
);

const runtimeNodeDataKeySet = new Set(runtimeNodeDataKeys);
const transientNodeKeys = new Set(["width", "height", "selected", "dragging", "positionAbsolute"]);
const transientEdgeKeys = new Set(["type", "markerEnd", "sourceHandle", "targetHandle", "zIndex"]);

const cleanNodeDataForSave = (data = {}) => omitKeys(data, runtimeNodeDataKeySet);

const cleanNodeForSave = (node = {}) => {
  const rest = omitKeys(node, transientNodeKeys);
  const style =
    node.type === "text"
      ? {
          ...(node.style || {}),
          width: node.width || node.style?.width || 200,
          height: node.height || node.style?.height || 200,
        }
      : node.style;
  return {
    ...rest,
    ...(style ? { style } : {}),
    data: cleanNodeDataForSave(node.data),
  };
};

const editableNodeData = (node) => {
  if (node.type !== "concert") return { ...node.data };
  const inputParamValues =
    node.data.inputParamValues ||
    Object.fromEntries(
      Object.entries(node.data.inputParams || {}).map(([key, value]) => [
        key,
        stringifyParamValue(value),
      ]),
    );
  return {
    ...node.data,
    inputParamValues,
  };
};

const cleanEdgeForSave = (edge = {}) => {
  const rest = omitKeys(edge, transientEdgeKeys);
  const savedData = omitKeys(rest.data, new Set(["columns"]));
  return {
    ...rest,
    data: savedData,
  };
};

const snapToConcertGrid = (value, size = 100) => Math.round(value / size) * size;

const selectedGraphFragment = (nodes, edges, selectedNodeIds) => {
  const selectedIds = new Set(selectedNodeIds || []);
  const selectedNodes = nodes.filter((node) => selectedIds.has(node.id));
  if (!selectedNodes.length) return null;

  const selectedEdges = edges.filter(
    (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target),
  );
  const minX = Math.min(...selectedNodes.map((node) => node.position?.x ?? 0));
  const minY = Math.min(...selectedNodes.map((node) => node.position?.y ?? 0));

  return {
    nodes: selectedNodes.map(cleanNodeForSave),
    edges: selectedEdges.map(cleanEdgeForSave),
    anchor: { x: minX, y: minY },
  };
};

const hydrateRunParamValues = (inputVariables, currentValues = {}) =>
  Object.fromEntries(
    (inputVariables || []).map((item) => {
      const name = normalizeVariableName(item.name);
      const currentValue = currentValues[name];
      return [
        name,
        currentValue === undefined || currentValue === ""
          ? String(item.defaultValue ?? "")
          : currentValue,
      ];
    }),
  );

const replayRunParamValues = (inputVariables, replayParams = {}) => {
  const normalizedValues = Object.fromEntries(
    Object.entries(replayParams || {}).map(([name, value]) => [
      normalizeVariableName(name),
      value,
    ]),
  );
  return hydrateRunParamValues(inputVariables, normalizedValues);
};

const replayInputValueHistory = (inputVariables, replays) => {
  const names = (inputVariables || []).map((item) =>
    normalizeVariableName(item.name).replace(/^\$+/, ""),
  );
  return Object.fromEntries(
    names.map((name) => [
      `$${name}`,
      [
        ...new Set(
          (replays || [])
            .map((replay) => replay.params?.[name])
            .filter((value) => value !== undefined && value !== null)
            .map((value) =>
              typeof value === "string" ? value : JSON.stringify(value),
            ),
        ),
      ],
    ]),
  );
};

const hasConcertNodeChange = (changes) =>
  changes.some(
    (change) => !["select", "dimensions", "position"].includes(change.type),
  );
const hasConcertEdgeChange = (changes) =>
  changes.some((change) => change.type !== "select");

function LoopInEditor({ editData, setEditData, inputColumns = [] }) {
  const [newGroupByColumn, setNewGroupByColumn] = useState("");
  const selectedGroupByColumns = new Set(
    String(editData.groupByColumns || "")
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean),
  );
  const knownInputColumnNames = new Set(
    inputColumns.map((column) => column.name),
  );
  const customGroupByColumns = Array.from(selectedGroupByColumns).filter(
    (columnName) => !knownInputColumnNames.has(columnName),
  );

  const updateGroupByColumn = (columnName, checked) => {
    setEditData((current) => {
      const nextColumns = new Set(
        String(current.groupByColumns || "")
          .split(",")
          .map((column) => column.trim())
          .filter(Boolean),
      );
      if (checked) {
        nextColumns.add(columnName);
      } else {
        nextColumns.delete(columnName);
      }
      return {
        ...current,
        groupByColumns: Array.from(nextColumns).join(", "),
      };
    });
  };

  const addCustomGroupByColumn = () => {
    const columnName = newGroupByColumn.trim();
    if (!columnName || selectedGroupByColumns.has(columnName)) return;
    updateGroupByColumn(columnName, true);
    setNewGroupByColumn("");
  };

  return (
    <div className="node-form-editor">
      <div className="loop-in-layout">
        <aside className="column-side-panel">
          <div className="column-title">Input Columns</div>
          <div className="column-list">
            {inputColumns.length ? (
              inputColumns.map((column) => (
                <div
                  className="column-row"
                  key={`${column.name}-${column.type}`}
                >
                  <span className="column-name">{column.name}</span>
                  <span className="column-type">{column.type}</span>
                </div>
              ))
            ) : (
              <div className="column-empty">
                Run parent node to inspect columns.
              </div>
            )}
          </div>
        </aside>

        <div className="loop-in-settings">
          <div className="loop-iteration-label-row">
            <span className="field-label">Iteration Mode</span>
            {["eachRow", "groupBy"].includes(editData.iterationMode) && (
              <span className="loop-parallel-warning">
                Iterations run in parallel; execution order is not sequential.
              </span>
            )}
          </div>
          <div className="loop-iteration-radios" role="radiogroup" aria-label="Iteration Mode">
            {[
              ["allRows", "All rows"],
              ["eachRow", "Each row"],
              ["groupBy", "Group by columns"],
            ].map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="loop-iteration-mode"
                  value={value}
                  checked={(editData.iterationMode || "allRows") === value}
                  onChange={(event) =>
                    setEditData((current) => ({
                      ...current,
                      iterationMode: event.target.value,
                    }))
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          {(editData.iterationMode || "allRows") === "groupBy" && (
            <div className="loop-group-section">
              <label className="field-label">Group By Columns</label>
              <div className="column-list loop-column-checklist">
                {inputColumns.length ? (
                  inputColumns.map((column) => (
                    <label
                      className="loop-column-checkbox-row"
                      key={`${column.name}-${column.type}`}
                    >
                      <input
                        type="checkbox"
                        checked={selectedGroupByColumns.has(column.name)}
                        onChange={(event) =>
                          updateGroupByColumn(column.name, event.target.checked)
                        }
                      />
                      <span className="column-name">{column.name}</span>
                      <span className="column-type">{column.type}</span>
                    </label>
                  ))
                ) : (
                  <div className="column-empty">
                    Input columns are not available yet. Add them manually below.
                  </div>
                )}
              </div>

              <label className="field-label">Manual Group Columns</label>
              <div className="loop-group-manual-list">
                {customGroupByColumns.map((columnName) => (
                  <div className="loop-group-manual-row" key={columnName}>
                    <input className="text-input" value={columnName} readOnly />
                    <button
                      type="button"
                      onClick={() => updateGroupByColumn(columnName, false)}
                      title={`Remove ${columnName}`}
                    >
                      Delete
                    </button>
                  </div>
                ))}
                <div className="loop-group-manual-row">
                  <input
                    className="text-input"
                    value={newGroupByColumn}
                    placeholder="Column name"
                    onChange={(event) => setNewGroupByColumn(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      addCustomGroupByColumn();
                    }}
                  />
                  <button
                    type="button"
                    onClick={addCustomGroupByColumn}
                    disabled={!newGroupByColumn.trim()}
                  >
                    Add
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const loopStopOperators = ["==", "!=", ">=", ">", "<=", "<"];

function LoopOutEditor({
  editData,
  setEditData,
  inputColumns = [],
  iterationMode = "allRows",
}) {
  const [selectedInputColumns, setSelectedInputColumns] = useState(new Set());
  const [selectedConditionColumns, setSelectedConditionColumns] = useState(
    new Set(),
  );
  const stopConditions = Array.isArray(editData.stopConditions)
    ? editData.stopConditions
    : [];

  const toggleInputColumn = (columnName, checked) => {
    setSelectedInputColumns((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(columnName);
      } else {
        next.delete(columnName);
      }
      return next;
    });
  };

  const addSelectedColumns = () => {
    if (!selectedInputColumns.size) return;
    setEditData((current) => {
      const currentConditions = Array.isArray(current.stopConditions)
        ? current.stopConditions
        : [];
      const existingColumns = new Set(
        currentConditions.map((condition) => condition.column),
      );
      const addedConditions = Array.from(selectedInputColumns)
        .filter((column) => !existingColumns.has(column))
        .map((column) => ({
          column,
          operator: "==",
          value: "",
        }));
      return {
        ...current,
        stopConditions: [...currentConditions, ...addedConditions],
      };
    });
    setSelectedInputColumns(new Set());
  };

  const updateStopCondition = (index, patch) => {
    setEditData((current) => {
      const currentConditions = Array.isArray(current.stopConditions)
        ? current.stopConditions
        : [];
      return {
        ...current,
        stopConditions: currentConditions.map((condition, conditionIndex) =>
          conditionIndex === index ? { ...condition, ...patch } : condition,
        ),
      };
    });
  };

  const toggleConditionColumn = (columnName) => {
    setSelectedConditionColumns((current) => {
      const next = new Set(current);
      if (next.has(columnName)) {
        next.delete(columnName);
      } else {
        next.add(columnName);
      }
      return next;
    });
  };

  const removeSelectedConditions = () => {
    if (!selectedConditionColumns.size) return;
    setEditData((current) => {
      const currentConditions = Array.isArray(current.stopConditions)
        ? current.stopConditions
        : [];
      return {
        ...current,
        stopConditions: currentConditions.filter(
          (condition) => !selectedConditionColumns.has(condition.column),
        ),
      };
    });
    setSelectedConditionColumns(new Set());
  };

  return (
    <div className="node-form-editor">
      {iterationMode === "allRows" ? (
        <>
          <label className="field-label">Max Iterations</label>
          <input
            className="text-input"
            type="number"
            min="0"
            value={editData.maxIterations ?? "0"}
            onChange={(event) =>
              setEditData((current) => ({
                ...current,
                maxIterations: event.target.value,
              }))
            }
          />

          <label className="field-label">Stop Conditions</label>
          <div className="loop-stop-layout">
        <div className="loop-stop-panel">
          <div className="column-title">Input Columns</div>
          <div className="column-list loop-stop-column-list">
            {inputColumns.length ? (
              inputColumns.map((column) => (
                <label
                  className="loop-column-checkbox-row"
                  key={`${column.name}-${column.type}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedInputColumns.has(column.name)}
                    onChange={(event) =>
                      toggleInputColumn(column.name, event.target.checked)
                    }
                  />
                  <span className="column-name">{column.name}</span>
                  <span className="column-type">{column.type}</span>
                </label>
              ))
            ) : (
              <div className="column-empty">
                Connect and run parent node to inspect columns.
              </div>
            )}
          </div>
        </div>

        <div className="loop-stop-transfer">
          <button
            className="loop-transfer-button"
            type="button"
            onClick={addSelectedColumns}
            disabled={!selectedInputColumns.size}
          >
            &gt;&gt;
          </button>
          <button
            className="loop-transfer-button"
            type="button"
            onClick={removeSelectedConditions}
            disabled={!selectedConditionColumns.size}
          >
            &lt;&lt;
          </button>
        </div>

        <div className="loop-stop-panel">
          <div className="loop-stop-condition-header">
            <span>Column</span>
            <span>Operator</span>
            <span>Value</span>
          </div>
          <div className="loop-stop-condition-list">
            {stopConditions.length ? (
              stopConditions.map((condition, index) => (
                <div
                  className={`loop-stop-condition-row${
                    selectedConditionColumns.has(condition.column)
                      ? " selected"
                      : ""
                  }`}
                  key={`${condition.column}-${index}`}
                  onClick={(event) => {
                    if (event.target.closest("input, select")) return;
                    toggleConditionColumn(condition.column);
                  }}
                  title="Select this condition to remove it with <<"
                >
                  <div className="loop-stop-column-name" title={condition.column}>
                    {condition.column}
                  </div>
                  <select
                    className="text-input"
                    value={condition.operator || "=="}
                    onChange={(event) =>
                      updateStopCondition(index, {
                        operator: event.target.value,
                      })
                    }
                  >
                    {loopStopOperators.map((operator) => (
                      <option value={operator} key={operator}>
                        {operator}
                      </option>
                    ))}
                  </select>
                  <input
                    className="text-input"
                    value={condition.value ?? ""}
                    onChange={(event) =>
                      updateStopCondition(index, { value: event.target.value })
                    }
                  />
                </div>
              ))
            ) : (
              <div className="column-empty">No stop conditions.</div>
            )}
          </div>
        </div>
          </div>
        </>
      ) : (
        <div className="column-empty">
          Max Iterations and Stop Conditions are available only in All rows mode.
        </div>
      )}
    </div>
  );
}

function EditorPanel({
  selectedNode,
  editData,
  setEditData,
  searchHighlight,
  inputDataframes,
  outputColumns,
  outputMessage,
  loopIterationMode,
  apiBaseUrl,
  globalVariables,
  inputVariables,
  onSave,
  onClose,
  onRequestClose,
}) {
  const [isPyomoCodeOpen, setIsPyomoCodeOpen] = useState(false);
  const [pyomoCopyToast, setPyomoCopyToast] = useState("");
  const pyomoCopyToastTimerRef = useRef(null);

  if (!selectedNode || !editData) return null;

  return (
    <div
      className="editor-modal-backdrop"
      onClick={onRequestClose}
      onKeyDown={(event) => {
        if (event.key === "Escape" && isPyomoCodeOpen) {
          event.preventDefault();
          setIsPyomoCodeOpen(false);
        }
        event.stopPropagation();
      }}
    >
      <aside className="editor-panel" onClick={(event) => event.stopPropagation()}>
        <div className="editor-header">
          <div>
            <div className="eyebrow">{nodeTypeLabel(selectedNode.type)}</div>
            <h2>Edit Node</h2>
          </div>
          <button type="button" className="icon-button" onClick={onRequestClose} title="Close">
            ×
          </button>
        </div>

        <label className="field-label">Name</label>
        <input
          className="text-input"
          value={editData.name || ""}
          onChange={(event) => {
            const nextName = event.target.value;
            setEditData((current) => ({
              ...current,
              name: nextName,
              code:
                selectedNode.type === "python" &&
                /^[A-Za-z0-9_]+$/.test(nextName) &&
                (!current.code ||
                  current.code.includes(`func_${safeName(current.name)}`))
                  ? pythonTemplate(nextName)
                  : current.code,
            }));
          }}
        />

        <label className="field-label">Node ID</label>
        <input className="text-input" value={selectedNode.id} readOnly />

        <div className="editor-body">
          {selectedNode.type === "dbRead" && (
            <DbEditor
              editData={editData}
              setEditData={setEditData}
              searchHighlight={searchHighlight}
              inputDataframes={inputDataframes}
              outputColumns={outputColumns}
              outputMessage={outputMessage}
              apiBaseUrl={apiBaseUrl}
              globalVariables={globalVariables}
              inputVariables={inputVariables}
            />
          )}
          {selectedNode.type === "python" && (
            <PythonEditor
              editData={editData}
              setEditData={setEditData}
              searchHighlight={searchHighlight}
              inputDataframes={inputDataframes}
              outputColumns={outputColumns}
              outputMessage={outputMessage}
            />
          )}
          {selectedNode.type === "opl" && (
            <OplEditor
              editData={editData}
              setEditData={setEditData}
              inputDataframes={inputDataframes}
            />
          )}
          {selectedNode.type === "dbWrite" && (
            <DbEditor
              editData={editData}
              setEditData={setEditData}
              searchHighlight={searchHighlight}
              inputDataframes={inputDataframes}
              outputColumns={outputColumns}
              outputMessage={outputMessage}
              describeEnabled={false}
              apiBaseUrl={apiBaseUrl}
              globalVariables={globalVariables}
              inputVariables={inputVariables}
            />
          )}
          {selectedNode.type === "concert" && (
            <ConcertCallEditor
              editData={editData}
              setEditData={setEditData}
              apiBaseUrl={apiBaseUrl}
              inputDataframes={inputDataframes}
              outputColumns={outputColumns}
              outputMessage={outputMessage}
            />
          )}
          {selectedNode.type === "concertInput" && <InputEditor />}
          {selectedNode.type === "concertOutput" && <OutputEditor />}
          {["cacheRead", "cacheWrite"].includes(selectedNode.type) && (
            <ResourceEditor
              data={editData}
              onChange={setEditData}
              kind={selectedNode.type.startsWith("cache") ? "cache" : "file"}
              write={selectedNode.type.endsWith("Write")}
              apiBaseUrl={apiBaseUrl}
            />
          )}
          {selectedNode.type === "loopIn" && (
            <LoopInEditor
              editData={editData}
              setEditData={setEditData}
              inputColumns={
                inputDataframes.find((input) => input.columns.length)?.columns ||
                outputColumns ||
                []
              }
            />
          )}
          {selectedNode.type === "loopOut" && (
            <LoopOutEditor
              editData={editData}
              setEditData={setEditData}
              iterationMode={loopIterationMode}
              inputColumns={
                inputDataframes.find((input) => input.columns.length)?.columns ||
                outputColumns ||
                []
              }
            />
          )}
          {selectedNode.type === "text" && (
            <TextEditor editData={editData} setEditData={setEditData} />
          )}
        </div>

        <div className="editor-actions">
          {selectedNode.type === "opl" && (
            <button type="button" onClick={() => { setPyomoCopyToast(""); setIsPyomoCodeOpen(true); }}>
              View Pyomo Code
            </button>
          )}
          <div className="action-spacer" />
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary-button"
            onClick={onSave}
            disabled={selectedNode.type === "concert" && editData.concertInputsLoading}
          >
            Save
          </button>
        </div>
      </aside>
      {selectedNode.type === "opl" && isPyomoCodeOpen && (
        <div className="opl-code-backdrop" onClick={() => setIsPyomoCodeOpen(false)}>
          <section className="opl-code-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="opl-code-dialog-header">
              <div>
                <div className="eyebrow">Generated Preview</div>
                <h3>Pyomo Code</h3>
              </div>
              <button type="button" className="icon-button" onClick={() => setIsPyomoCodeOpen(false)}>×</button>
            </div>
            <pre>{buildPyomoCode(editData)}</pre>
            <div className="editor-actions">
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(buildPyomoCode(editData));
                  setPyomoCopyToast("Copied");
                  window.clearTimeout(pyomoCopyToastTimerRef.current);
                  pyomoCopyToastTimerRef.current = window.setTimeout(() => setPyomoCopyToast(""), 1600);
                }}
              >
                Copy Code
              </button>
              <div className="action-spacer" />
              <button type="button" onClick={() => setIsPyomoCodeOpen(false)}>Close</button>
            </div>
            {pyomoCopyToast && <div className="opl-copy-toast" role="status">{pyomoCopyToast}</div>}
          </section>
        </div>
      )}
    </div>
  );
}

const formatDurationMs = (value) => {
  const ms = Number(value || 0);
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${minutes}m ${remainingSeconds.toFixed(1)}s`;
};

function RunCompleteDialog({ timing, onClose }) {
  const totalElapsedMs = timing?.totalElapsedMs ?? 0;
  const processCreateMs = timing?.processCreateMs ?? 0;
  const oraclePoolInitMs = timing?.oraclePoolInitMs ?? 0;
  const buildConcertMs = timing?.buildConcertMs ?? 0;
  const replaySaveMs = timing?.replaySaveMs ?? 0;
  const executionMs =
    timing?.executionMs ??
    Math.max(0, (timing?.executionReplayMs ?? 0) - replaySaveMs);
  const cacheSaveMs = timing?.cacheSaveMs ?? 0;

  return (
    <div className="modal-backdrop run-complete-backdrop">
      <section
        className="run-complete-dialog"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <div className="eyebrow">Run Complete</div>
          <h3>Concert execution finished</h3>
        </div>
        <div className="run-complete-times">
          <div>
            <span>Total elapsed</span>
            <strong>{formatDurationMs(totalElapsedMs)}</strong>
          </div>
          <div>
            <span>Process startup</span>
            <strong>{formatDurationMs(processCreateMs)}</strong>
          </div>
          <div>
            <span>Oracle pool initialization</span>
            <strong>{formatDurationMs(oraclePoolInitMs)}</strong>
          </div>
          <div>
            <span>Concert build</span>
            <strong>{formatDurationMs(buildConcertMs)}</strong>
          </div>
          <div>
            <span>Execution</span>
            <strong>{formatDurationMs(executionMs)}</strong>
          </div>
          <div>
            <span>Replay save</span>
            <strong>{formatDurationMs(replaySaveMs)}</strong>
          </div>
          <div>
            <span>Cache save</span>
            <strong>{formatDurationMs(cacheSaveMs)}</strong>
          </div>
        </div>
        <div className="editor-actions">
          <div className="action-spacer" />
          <button className="primary-button" onClick={onClose}>
            OK
          </button>
        </div>
      </section>
    </div>
  );
}

const ConcertTabView = forwardRef(function ConcertTabView(
  {
    onConcertFileLabelChange = () => {},
    onActiveConcertChange = () => {},
    defaultServerName = "Local",
    defaultApiBaseUrl = "http://localhost:8000",
    servers = [],
  },
  ref,
) {
  const { showError } = useErrorDialog();
  const [nodes, setNodes] = useNodesState(initialNodes);
  const [edges, setEdges] = useEdgesState(initialEdges);
  const [isTabOpen, setIsTabOpen] = useState(false);
  const [tabs, setTabs] = useState([]);
  const tabsRef = useRef([]);
  const openingServerConcertsRef = useRef(new Map());
  const [activeTabId, setActiveTabId] = useState(null);
  const [concertId, setConcertId] = useState(() => crypto.randomUUID());
  const [lastCommitId, setLastCommitId] = useState(null);
  const [commitId, setCommitId] = useState(null);
  const [concertName, setConcertName] = useState("untitled_concert");
  const [concertFileLabel, setConcertFileLabel] = useState("untitled_concert");
  const [concertFileHandle, setConcertFileHandle] = useState(null);
  const [version, setVersion] = useState("");
  const apiBaseUrl = defaultApiBaseUrl;
  const [replayServerName, setReplayServerName] = useState(defaultServerName);
  const replayServer =
    servers.find((server) => server.name === replayServerName) ||
    servers.find((server) => server.name === defaultServerName);
  const replayApiBaseUrl = replayServer
    ? `http://${replayServer.host}:${replayServer.port}`
    : defaultApiBaseUrl;
  const [editData, setEditData] = useState(null);
  const [run, setRun] = useState(null);
  const [activeRunId, setActiveRunId] = useState(null);
  const [openingConcertName, setOpeningConcertName] = useState("");
  const [lastRunId, setLastRunId] = useState(null);
  const [runCompleteTiming, setRunCompleteTiming] = useState(null);
  const [replays, setReplays] = useState([]);
  const [selectedReplayId, setSelectedReplayId] = useState("");
  const [globalVariables, setGlobalVariables] = useState([]);
  const [inputVariables, setInputVariables] = useState([]);
  const [runParamValues, setRunParamValues] = useState({});
  const [pendingRun, setPendingRun] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [searchHighlight, setSearchHighlight] = useState(null);
  const [activeSubMenu, setActiveSubMenu] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const [isSearchVisible, setIsSearchVisible] = useState(true);
  const [searchHeight, setSearchHeight] = useState(220);
  const [searchInputTerm, setSearchInputTerm] = useState("");
  const [searchSubmittedTerm, setSearchSubmittedTerm] = useState("");
  const [isOutputVisible, setIsOutputVisible] = useState(true);
  const [outputHeight, setOutputHeight] = useState(220);
  const [activeBottomPanel, setActiveBottomPanel] = useState("search");
  const [isDirty, setIsDirty] = useState(false);
  const [isConnectMode, setIsConnectMode] = useState(false);
  const [isSaveChangesDialogOpen, setIsSaveChangesDialogOpen] = useState(false);
  const [pendingCloseTabId, setPendingCloseTabId] = useState(null);
  const [isVariablesDialogOpen, setIsVariablesDialogOpen] = useState(false);
  const [isReplayDialogOpen, setIsReplayDialogOpen] = useState(false);
  const [runCacheSelection, setRunCacheSelection] = useState(null);
  const openInputRef = useRef(null);
  const subMenuRef = useRef(null);
  const contextMenuRef = useRef(null);
  const reactFlowRef = useRef(null);
  const replayRequestRef = useRef(0);
  const graphRef = useRef({ nodes: initialNodes, edges: initialEdges });
  const viewportRef = useRef({ x: 0, y: 0, zoom: 1 });
  const canvasRef = useRef(null);
  const isCanvasFocusedRef = useRef(false);
  const graphClipboardRef = useRef(null);
  const pointerPositionRef = useRef(null);
  const bottomPanelDragRef = useRef(null);
  const nodeResizeHistoryRef = useRef(null);

  useEffect(() => {
    if (run?.status === "error" && !activeRunId) {
      showError(run.error || "Concert run failed.");
    }
  }, [activeRunId, run?.error, run?.status, showError]);

  useEffect(() => {
    const closeSubMenuOutside = (event) => {
      const menuRoot = event.target.closest?.(".menu-root");
      if (!menuRoot || !subMenuRef.current?.contains(menuRoot)) {
        setActiveSubMenu(null);
      }
    };
    document.addEventListener("pointerdown", closeSubMenuOutside, true);
    return () => {
      document.removeEventListener("pointerdown", closeSubMenuOutside, true);
    };
  }, []);

  useEffect(() => {
    const closeContextMenuOutside = (event) => {
      if (!contextMenuRef.current?.contains(event.target)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("pointerdown", closeContextMenuOutside, true);
    return () => {
      document.removeEventListener("pointerdown", closeContextMenuOutside, true);
    };
  }, []);

  const suppressNextEdgeHistoryRef = useRef(false);
  const nodeMoveHistoryRef = useRef(null);
  const viewNodeDataRef = useRef(null);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    graphRef.current = { nodes, edges };
  }, [edges, nodes]);
  const selectedNodes = useMemo(
    () => nodes.filter((node) => node.selected),
    [nodes],
  );
  const selectedNode = selectedNodes.length === 1 ? selectedNodes[0] : null;

  const clearNodeSelection = useCallback(() => {
    const nextNodes = graphRef.current.nodes.map((node) =>
      node.selected ? { ...node, selected: false } : node,
    );
    graphRef.current = { ...graphRef.current, nodes: nextNodes };
    setNodes(nextNodes);
  }, [setNodes]);

  const selectOnlyNode = useCallback(
    (nodeId) => {
      const nextNodes = graphRef.current.nodes.map((node) => ({
        ...node,
        selected: node.id === nodeId,
      }));
      graphRef.current = { ...graphRef.current, nodes: nextNodes };
      setNodes(nextNodes);
    },
    [setNodes],
  );

  const getCurrentViewport = useCallback(() => {
    const viewport =
      reactFlowRef.current?.getViewport?.() || viewportRef.current;
    viewportRef.current = viewport;
    return viewport;
  }, []);

  const currentTabSnapshot = useCallback(
    () => ({
      id: activeTabId || makeId(),
      concertId,
      lastCommitId,
      commitId,
      concertName,
      concertFileLabel,
      concertFileHandle,
      version,
      nodes: cloneValue(nodes),
      edges: cloneValue(edges),
      globalVariables: cloneValue(globalVariables),
      inputVariables: cloneValue(inputVariables),
      runParamValues: cloneValue(runParamValues),
      run: cloneValue(run),
      activeRunId,
      lastRunId,
      runCompleteTiming: cloneValue(runCompleteTiming),
      replays: cloneValue(replays),
      selectedReplayId,
      undoStack: cloneValue(undoStack),
      redoStack: cloneValue(redoStack),
      viewport: cloneValue(viewportRef.current),
      isSearchVisible,
      searchHeight,
      searchInputTerm,
      searchSubmittedTerm,
      isOutputVisible,
      outputHeight,
      activeBottomPanel,
      isDirty,
    }),
    [
      activeTabId,
      activeBottomPanel,
      activeRunId,
      concertFileHandle,
      concertFileLabel,
      concertName,
      concertId,
      lastCommitId,
      commitId,
      version,
      edges,
      globalVariables,
      inputVariables,
      isDirty,
      isOutputVisible,
      lastRunId,
      nodes,
      outputHeight,
      redoStack,
      replays,
      run,
      runCompleteTiming,
      runParamValues,
      searchHeight,
      searchInputTerm,
      searchSubmittedTerm,
      isSearchVisible,
      selectedReplayId,
      undoStack,
    ],
  );

  const restoreTabSnapshot = useCallback(
    (tab) => {
      setIsTabOpen(true);
      setConcertId(tab.concertId);
      setLastCommitId(tab.lastCommitId);
      setCommitId(tab.commitId);
      setConcertName(tab.concertName);
      setConcertFileLabel(tab.concertFileLabel);
      setConcertFileHandle(tab.concertFileHandle || null);
      setVersion(tab.version || "");
      setNodes(
        cloneValue(tab.nodes || []).map((node) => ({
          ...node,
          selected: false,
        })),
      );
      setEdges((tab.edges || []).map(normalizeEdge));
      setGlobalVariables(cloneValue(tab.globalVariables || []));
      setInputVariables(cloneValue(tab.inputVariables || []));
      setRunParamValues(cloneValue(tab.runParamValues || {}));
      setRun(cloneValue(tab.run || null));
      setActiveRunId(tab.activeRunId || null);
      setLastRunId(tab.lastRunId || null);
      setRunCompleteTiming(cloneValue(tab.runCompleteTiming || null));
      setReplays(cloneValue(tab.replays || []));
      setSelectedReplayId(tab.selectedReplayId || "");
      const nextUndoStack = cloneValue(tab.undoStack || []);
      const nextRedoStack = cloneValue(tab.redoStack || []);
      undoStackRef.current = nextUndoStack;
      redoStackRef.current = nextRedoStack;
      setUndoStack(nextUndoStack);
      setRedoStack(nextRedoStack);
      viewportRef.current = tab.viewport || { x: 0, y: 0, zoom: 1 };
      const nextSearchVisible = tab.isSearchVisible ?? true;
      const nextOutputVisible = tab.isOutputVisible ?? true;
      setIsSearchVisible(nextSearchVisible);
      setSearchHeight(tab.searchHeight || 220);
      setSearchInputTerm(tab.searchInputTerm || "");
      setSearchSubmittedTerm(tab.searchSubmittedTerm || "");
      setIsOutputVisible(nextOutputVisible);
      setOutputHeight(tab.outputHeight || 220);
      setActiveBottomPanel(
        tab.activeBottomPanel === "output" && nextOutputVisible
          ? "output"
          : nextSearchVisible
            ? "search"
            : "output",
      );
      setIsDirty(Boolean(tab.isDirty));
      setEditData(null);
      setSearchHighlight(null);
      setContextMenu(null);
      setPendingRun(null);
      setIsSaveChangesDialogOpen(false);
      setIsVariablesDialogOpen(false);
      setIsReplayDialogOpen(false);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          reactFlowRef.current?.setViewport?.(viewportRef.current, {
            duration: 0,
          });
        });
      });
    },
    [setEdges, setNodes],
  );

  const saveActiveTabSnapshot = useCallback(() => {
    if (!activeTabId || !isTabOpen) return;
    const snapshot = {
      ...currentTabSnapshot(),
      viewport: cloneValue(getCurrentViewport()),
    };
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTabId ? { ...tab, ...snapshot } : tab,
      ),
    );
  }, [activeTabId, currentTabSnapshot, getCurrentViewport, isTabOpen]);

  useEffect(() => {
    if (!activeTabId || !isTabOpen) return;
    const snapshot = currentTabSnapshot();
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTabId ? { ...tab, ...snapshot } : tab,
      ),
    );
  }, [activeTabId, currentTabSnapshot, isTabOpen]);

  const clearReplayState = useCallback(() => {
    replayRequestRef.current += 1;
    setSelectedReplayId("");
    setReplays([]);
  }, []);

  const openNewTab = useCallback(() => {
    saveActiveTabSnapshot();
    const nextTab = createBlankTab();
    setTabs((current) => [...current, nextTab]);
    setActiveTabId(nextTab.id);
    restoreTabSnapshot(nextTab);
  }, [restoreTabSnapshot, saveActiveTabSnapshot]);

  const switchTab = useCallback(
    (tabId) => {
      if (tabId === activeTabId) return;
      saveActiveTabSnapshot();
      const target = tabs.find((tab) => tab.id === tabId);
      if (!target) return;
      setActiveTabId(target.id);
      restoreTabSnapshot(target);
    },
    [activeTabId, restoreTabSnapshot, saveActiveTabSnapshot, tabs],
  );

  const closeTab = useCallback(
    (tabId) => {
      const index = tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      const nextTabs = tabs.filter((tab) => tab.id !== tabId);
      setPendingCloseTabId((current) => current === tabId ? null : current);
      setTabs(nextTabs);

      if (!nextTabs.length) {
        setActiveTabId(null);
        setIsTabOpen(false);
        setIsDirty(false);
        setEditData(null);
        setSearchHighlight(null);
        setContextMenu(null);
        setRun(null);
        setActiveRunId(null);
        setLastRunId(null);
        setPendingRun(null);
        setIsSaveChangesDialogOpen(false);
        setIsVariablesDialogOpen(false);
        setIsReplayDialogOpen(false);
        return;
      }

      if (tabId !== activeTabId) return;
      const nextActive = nextTabs[Math.max(0, index - 1)] || nextTabs[0];
      setActiveTabId(nextActive.id);
      restoreTabSnapshot(nextActive);
    },
    [activeTabId, restoreTabSnapshot, tabs],
  );

  const historyLabel = (entry) => entry?.label || "Change";
  const nodeNameById = useCallback((nodeId) => {
    const node = graphRef.current.nodes.find((item) => item.id === nodeId);
    return node?.data?.name || node?.id || nodeId;
  }, []);
  const edgeLabelById = useCallback(
    (edgeId) => {
      const edge = graphRef.current.edges.find((item) => item.id === edgeId);
      if (!edge) return edgeId;
      return `${nodeNameById(edge.source)} -> ${nodeNameById(edge.target)}`;
    },
    [nodeNameById],
  );

  const pushHistory = useCallback((label = "Change", state = null) => {
    const nextUndoStack = [
      ...undoStackRef.current,
      { state: state || stateForHistory(graphRef.current, globalVariables, inputVariables), label },
    ];
    undoStackRef.current = nextUndoStack;
    redoStackRef.current = [];
    setUndoStack(nextUndoStack);
    setRedoStack([]);
  }, [globalVariables, inputVariables]);

  const restoreGraph = useCallback(
    (snapshot) => {
      const historySnapshot = graphForHistory(snapshot.graph);
      const restoredNodes = restoreCurrentRuntimeData(
        historySnapshot.nodes,
        graphRef.current.nodes,
      );
      const restoredGraph = { nodes: restoredNodes, edges: historySnapshot.edges };
      graphRef.current = restoredGraph;
      setNodes(restoredNodes);
      setEdges(restoredGraph.edges);
      setGlobalVariables(cloneValue(snapshot.globalVariables));
      setInputVariables(cloneValue(snapshot.inputVariables));
      setEditData(null);
      setSearchHighlight(null);
      setContextMenu(null);
      setIsSaveChangesDialogOpen(false);
      setIsDirty(true);
    },
    [setEdges, setNodes],
  );

  const undo = useCallback(() => {
    const previous = undoStackRef.current.at(-1);
    if (!previous) return;
    const nextUndoStack = undoStackRef.current.slice(0, -1);
    const nextRedoStack = [...redoStackRef.current, {
      state: stateForHistory(graphRef.current, globalVariables, inputVariables),
      label: historyLabel(previous),
    }];
    undoStackRef.current = nextUndoStack;
    redoStackRef.current = nextRedoStack;
    setUndoStack(nextUndoStack);
    setRedoStack(nextRedoStack);
    restoreGraph(previous.state);
  }, [globalVariables, inputVariables, restoreGraph]);

  const redo = useCallback(() => {
    const next = redoStackRef.current.at(-1);
    if (!next) return;
    const nextRedoStack = redoStackRef.current.slice(0, -1);
    const nextUndoStack = [...undoStackRef.current, {
      state: stateForHistory(graphRef.current, globalVariables, inputVariables),
      label: historyLabel(next),
    }];
    redoStackRef.current = nextRedoStack;
    undoStackRef.current = nextUndoStack;
    setRedoStack(nextRedoStack);
    setUndoStack(nextUndoStack);
    restoreGraph(next.state);
  }, [globalVariables, inputVariables, restoreGraph]);

  const nextUndoLabel = undoStack.length
    ? historyLabel(undoStack[undoStack.length - 1])
    : "";
  const nextRedoLabel = redoStack.length
    ? historyLabel(redoStack[redoStack.length - 1])
    : "";

  const currentReplayConcertName = safeConcertPathName(concertName);
  const visibleReplays = useMemo(
    () => replays.filter((replay) => replay.concertName === currentReplayConcertName),
    [currentReplayConcertName, replays],
  );

  const selectedReplay = useMemo(
    () =>
      visibleReplays.find(
        (replay) =>
          replay.id === selectedReplayId &&
          replay.concertName === currentReplayConcertName,
      ) || null,
    [currentReplayConcertName, selectedReplayId, visibleReplays],
  );
  const selectedReplayLabel = selectedReplay
    ? selectedReplay.label ||
      `${selectedReplay.concertName || currentReplayConcertName}/${selectedReplay.id}`
    : "";

  useEffect(() => {
    onConcertFileLabelChange(concertFileLabel);
  }, [concertFileLabel, onConcertFileLabelChange]);

  useEffect(() => {
    onActiveConcertChange(isTabOpen);
  }, [isTabOpen, onActiveConcertChange]);


  const concertPayload = useCallback(
    (nameOverride = null, versionOverride = null) => {
      const nextName = safeConcertPathName(nameOverride || concertName);
      return {
        concertId,
        lastCommitId,
        commitId,
        version: versionOverride ?? version,
        name: nextName,
        globalVariables: variablePayload(globalVariables),
        inputVariables: variablePayload(inputVariables, "defaultValue"),
        nodes: nodes.map((node) => {
          if (!supportedNodeTypes.has(node.type)) throw new Error(`Unsupported Concert node type: ${node.type}`);
          validateNodeName(node.data?.name);
          return cleanNodeForSave(node);
        }),
        edges: edges.map(cleanEdgeForSave),
      };
    },
    [commitId, concertId, concertName, edges, globalVariables, inputVariables, lastCommitId, nodes, version],
  );

  const createTabFromConcertPayload = useCallback(
    (
      payload,
      { fileHandle = null, fileLabel = "", validatePayload = true } = {},
    ) => {
      if (
        validatePayload &&
        (!Object.hasOwn(payload, "lastCommitId") || !Object.hasOwn(payload, "commitId"))
      ) {
        throw new Error("Concert requires lastCommitId and commitId fields.");
      }
      const nextName = validatePayload
        ? concertBaseName(payload.name)
        : String(payload.name || "").replace(/\\/g, "/").split("/").at(-1);
      return {
        ...createBlankTab(),
        concertId: payload.concertId,
        lastCommitId: payload.lastCommitId,
        commitId: payload.commitId,
        concertName: nextName,
        concertFileLabel: fileLabel || nextName,
        concertFileHandle: fileHandle,
        version: typeof payload.version === "string" ? payload.version : "",
        nodes: payload.nodes.map((node) => {
          if (validatePayload && !supportedNodeTypes.has(node.type)) {
            throw new Error(`Unsupported Concert node type: ${node.type}`);
          }
          return {
            ...node,
            zIndex: node.type === "text" ? 0 : regularNodeZIndex,
            ...(node.type === "text"
              ? {
                  style: {
                    width: node.style?.width || 200,
                    height: node.style?.height || 200,
                  },
                }
              : {}),
            data: { ...node.data, status: "skipped" },
          };
        }),
        edges: payload.edges.map(normalizeEdge),
        globalVariables: payload.globalVariables,
        inputVariables: payload.inputVariables,
        runParamValues: variableInputDefaults(payload.inputVariables),
        isDirty: false,
      };
    },
    [],
  );

  const openConcertPayloadInTab = useCallback(
    (payload, options = {}) => {
      const nextTab = createTabFromConcertPayload(payload, options);
      const nextLabel = nextTab.concertFileLabel;
      const nextName = options.validatePayload === false
        ? nextTab.concertName
        : safeConcertPathName(nextTab.concertName);
      const existingTab = tabsRef.current.find((tab) => {
        if (options.fileHandle && tab.concertFileHandle === options.fileHandle)
          return true;
        if (nextLabel && tab.concertFileLabel === nextLabel) return true;
        return options.matchName !== false && safeConcertPathName(tab.concertName) === nextName;
      });

      saveActiveTabSnapshot();
      if (existingTab) {
        if (existingTab.id === activeTabId) return;
        setActiveTabId(existingTab.id);
        restoreTabSnapshot(existingTab);
        return;
      }

      const nextTabs = [...tabsRef.current, nextTab];
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      setActiveTabId(nextTab.id);
      restoreTabSnapshot(nextTab);
    },
    [
      activeTabId,
      createTabFromConcertPayload,
      restoreTabSnapshot,
      saveActiveTabSnapshot,
    ],
  );

  const writeConcertFile = useCallback(async (handle, nameOverride = null, versionOverride = null, commitOverrides = null) => {
    const writable = await handle.createWritable();
    const payload = {
      ...concertPayload(nameOverride, versionOverride),
      ...(commitOverrides || {}),
    };
    await writable.write(JSON.stringify(payload, null, 2));
    await writable.close();
    if (versionOverride != null) setVersion(versionOverride);
    if (commitOverrides && Object.hasOwn(commitOverrides, "lastCommitId")) setLastCommitId(commitOverrides.lastCommitId);
    if (commitOverrides && Object.hasOwn(commitOverrides, "commitId")) setCommitId(commitOverrides.commitId);
    setIsDirty(false);
  }, [concertPayload]);

  const inferConcertColumns = useCallback(async (
    targetNodes,
    targetEdges,
    targetGlobalVariables = globalVariables,
    targetInputVariables = inputVariables,
    startNodeId = null,
  ) => {
    const graph = executableGraph(targetNodes, targetEdges);
    if (!graph.nodes.length) {
      return { nodes: targetNodes, edges: targetEdges };
    }
    const response = await fetch(`${apiBaseUrl}/schema/infer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodes: graph.nodes.map((node) => ({
          ...node,
          data: cleanNodeDataForSave(node.data || {}),
        })),
        edges: graph.edges,
        globalVariables: targetGlobalVariables || [],
        inputVariables: targetInputVariables || [],
        params: runParamValues,
        startNodeId:
          startNodeId && graph.nodes.some((node) => node.id === startNodeId)
            ? startNodeId
            : null,
      }),
    });
    if (!response.ok) {
      throw new Error(`Infer Concert columns failed: ${await response.text()}`);
    }
    const body = await response.json();
    return {
      nodes: targetNodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          outputColumns: body.nodeColumns?.[node.id] || node.data?.outputColumns || [],
          schemaError: body.errors?.[node.id] || undefined,
        },
      })),
      edges: targetEdges.map((edge) => ({
        ...edge,
        data: {
          ...edge.data,
          columns: body.edgeColumns?.[edge.id] || edge.data?.columns || [],
        },
      })),
    };
  }, [apiBaseUrl, globalVariables, inputVariables, runParamValues]);

  const inferConcertPayloadColumns = useCallback(async (payload) => {
    try {
      const inferred = await inferConcertColumns(
        payload.nodes || [],
        payload.edges || [],
        payload.globalVariables || [],
        payload.inputVariables || [],
      );
      return { ...payload, nodes: inferred.nodes, edges: inferred.edges };
    } catch {
      return payload;
    }
  }, [inferConcertColumns]);

  const validateCalledConcerts = async (targetNodes) => {
    const concertNames = [
      ...new Set(
        targetNodes
          .filter((node) => node.type === "concert")
          .map((node) => node.data?.concertName || "")
          .filter(Boolean),
      ),
    ];

    for (const targetConcertName of concertNames) {
      const response = await fetch(`${apiBaseUrl}/playings-by-name/${encodeURIComponent(targetConcertName)}`);
      if (response.ok) continue;
      if (response.status === 404) {
        throw new Error(`Called Concert not found in backend: ${targetConcertName}`);
      }
      throw new Error(`Load called Concert failed: ${await response.text()}`);
    }
  };

  const saveConcertAsLocal = useCallback(async (versionOverride = null, deploymentName = null, commitOverrides = null) => {
    if (!isTabOpen) return validateConcertName(concertName);
    const fileName = `${validateConcertName(concertName)}.concert`;
    if ("showSaveFilePicker" in window) {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [
          {
            description: "Concert",
            accept: { "application/json": [".concert"] },
          },
        ],
      });
      const nextName = getFileNameBase(handle.name);
      const payloadName = deploymentName || nextName;
      await writeConcertFile(handle, payloadName, versionOverride, commitOverrides);
      setConcertFileHandle(handle);
      setIsTabOpen(true);
      setConcertName(nextName);
      setConcertFileLabel(getFileNameBase(handle.name));
      clearReplayState();
      return nextName;
    }

    const nextName = deploymentName ? safeConcertPathName(deploymentName) : safeConcertPathName(concertName);
    const payload = { ...concertPayload(nextName, versionOverride), ...(commitOverrides || {}) };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
    setConcertFileLabel(fileName);
    if (versionOverride != null) setVersion(versionOverride);
    if (commitOverrides && Object.hasOwn(commitOverrides, "lastCommitId")) setLastCommitId(commitOverrides.lastCommitId);
    if (commitOverrides && Object.hasOwn(commitOverrides, "commitId")) setCommitId(commitOverrides.commitId);
    setIsDirty(false);
    return nextName;
  }, [clearReplayState, concertName, concertPayload, isTabOpen, writeConcertFile]);

  const saveConcertLocal = useCallback(async (versionOverride = null, deploymentName = null, commitOverrides = null) => {
    if (!isTabOpen) return validateConcertName(concertName);
    if (concertFileHandle && "createWritable" in concertFileHandle) {
      const nextName = getFileNameBase(concertFileHandle.name || concertName);
      const payloadName = deploymentName || nextName;
      await writeConcertFile(concertFileHandle, payloadName, versionOverride, commitOverrides);
      setConcertName(nextName);
      return payloadName;
    }
    return saveConcertAsLocal(versionOverride, deploymentName, commitOverrides);
  }, [concertFileHandle, concertName, isTabOpen, saveConcertAsLocal, writeConcertFile]);

  const openConcertLocal = useCallback(async () => {
    if ("showOpenFilePicker" in window) {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
      });
      const file = await handle.getFile();
      const payload = await inferConcertPayloadColumns(
        JSON.parse(await file.text()),
      );
      openConcertPayloadInTab(payload, {
        expectedName: getFileNameBase(file.name),
        fileHandle: handle,
        fileLabel: getFileNameBase(file.name),
      });
      return;
    }

    openInputRef.current?.click();
  }, [inferConcertPayloadColumns, openConcertPayloadInTab]);

  const openServerConcert = useCallback(async (name, concertIdOverride = "") => {
    const key = concertIdOverride || name;
    const pending = openingServerConcertsRef.current.get(key);
    if (pending) return pending;
    const operation = (async () => {
      setOpeningConcertName(concertBaseName(name));
      const lookupPath = concertIdOverride
        ? `/playings-by-id/${encodeURIComponent(concertIdOverride)}`
        : `/playings-by-name/${encodeURIComponent(concertBaseName(name))}`;
      const response = await fetch(`${apiBaseUrl}${lookupPath}`);
      if (!response.ok) throw new Error(`Open Concert failed: ${await response.text()}`);
      const payload = await inferConcertPayloadColumns(await response.json());
      openConcertPayloadInTab(payload, {
        fileLabel: name.split("/").pop(),
        matchName: false,
        validatePayload: false,
      });
    })();
    openingServerConcertsRef.current.set(key, operation);
    try {
      return await operation;
    } finally {
      openingServerConcertsRef.current.delete(key);
      setOpeningConcertName("");
    }
  }, [apiBaseUrl, inferConcertPayloadColumns, openConcertPayloadInTab]);

  const openDeploymentConcert = useCallback(async (item) => {
    if (item.kind === "playing") return openServerConcert(item.name, item.concertId);
    const key = `${item.kind}:${item.path}`;
    const pending = openingServerConcertsRef.current.get(key);
    if (pending) return pending;
    const operation = (async () => {
      setOpeningConcertName(item.path.split("/").pop().replace(/\.concert$/, ""));
      const query = new URLSearchParams({ kind: item.kind, path: item.path });
      const response = await fetch(`${apiBaseUrl}/deployments/file?${query}`);
      if (!response.ok) throw new Error(`Open Concert failed: ${await response.text()}`);
      const payload = await inferConcertPayloadColumns(await response.json());
      const fileLabel = item.path.split("/").pop().replace(/\.concert$/, "");
      openConcertPayloadInTab(payload, {
        fileLabel,
        matchName: false,
        validatePayload: false,
      });
    })();
    openingServerConcertsRef.current.set(key, operation);
    try {
      return await operation;
    } finally {
      openingServerConcertsRef.current.delete(key);
      setOpeningConcertName("");
    }
  }, [apiBaseUrl, inferConcertPayloadColumns, openConcertPayloadInTab, openServerConcert]);

  const handleFallbackOpen = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const payload = await inferConcertPayloadColumns(JSON.parse(await file.text()));
      openConcertPayloadInTab(payload, {
        expectedName: getFileNameBase(file.name),
        fileHandle: null,
        fileLabel: getFileNameBase(file.name),
      });
    } catch (error) {
      showError(`Open Concert failed: ${error.message}`);
    }
  };

  const handleConcertFileDragOver = (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "none";
  };

  const handleConcertFileDrop = (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    event.stopPropagation();
    setRun({
      status: "error",
      nodes: {},
      error: "Drag-and-drop file opening is disabled. Use File > Open.",
    });
  };

  const requestCloseTab = useCallback(
    (tabId) => {
      const target = tabs.find((tab) => tab.id === tabId);
      if (!target) return;
      const dirty = tabId === activeTabId ? isDirty : Boolean(target.isDirty);
      if (!dirty) {
        closeTab(tabId);
        return;
      }
      if (tabId !== activeTabId) switchTab(tabId);
      setPendingCloseTabId(tabId);
    },
    [activeTabId, closeTab, isDirty, switchTab, tabs],
  );

  const closeConcert = useCallback(() => {
    if (activeTabId) {
      requestCloseTab(activeTabId);
      return;
    }
    setIsTabOpen(false);
  }, [activeTabId, requestCloseTab]);

  const saveAndClosePendingTab = useCallback(async () => {
    if (!pendingCloseTabId) return;
    try {
      await saveConcertLocal();
      const tabId = pendingCloseTabId;
      setPendingCloseTabId(null);
      closeTab(tabId);
    } catch (error) {
      if (error?.name !== "AbortError") {
        setRun({ status: "error", nodes: {}, error: `Save Concert failed: ${error.message}` });
      }
    }
  }, [closeTab, pendingCloseTabId, saveConcertLocal]);

  const discardAndClosePendingTab = useCallback(() => {
    if (!pendingCloseTabId) return;
    const tabId = pendingCloseTabId;
    setPendingCloseTabId(null);
    closeTab(tabId);
  }, [closeTab, pendingCloseTabId]);

  const hasDirtyTabs =
    Boolean(activeTabId && isDirty) ||
    tabs.some((tab) => tab.id !== activeTabId && Boolean(tab.isDirty));

  useEffect(() => {
    if (!hasDirtyTabs) return undefined;

    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [hasDirtyTabs]);

  const loadReplays = useCallback(async () => {
    const name = currentReplayConcertName;
    if (!name) return;
    const requestId = replayRequestRef.current + 1;
    replayRequestRef.current = requestId;
    const response = await fetch(
      `${replayApiBaseUrl}/replays?concertName=${encodeURIComponent(name)}`,
    );
    if (!response.ok) return;
    const body = await response.json();
    if (requestId !== replayRequestRef.current) return;
    const nextReplays = (body.replays || [])
      .filter((replay) => replay.concertName === name)
      .map((replay) => ({
        ...replay,
        replayServerName,
        replayApiBaseUrl,
      }));
    setReplays(nextReplays);
    setSelectedReplayId((current) => {
      if (nextReplays.some((replay) => replay.id === current)) return current;
      return "";
    });
  }, [currentReplayConcertName, replayApiBaseUrl, replayServerName]);

  const changeReplayServer = useCallback(async (nextServerName) => {
    if (nextServerName === replayServerName) return true;
    const nextServer = servers.find((server) => server.name === nextServerName);
    if (!nextServer) {
      showError(`Server not found: ${nextServerName}.`);
      return false;
    }
    const nextApiBaseUrl = `http://${nextServer.host}:${nextServer.port}`;
    try {
      const response = await fetch(`${nextApiBaseUrl}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const body = response.ok ? await response.json() : null;
      if (!response.ok || body?.status !== "ok") throw new Error();
      setReplayServerName(nextServerName);
      setSelectedReplayId("");
      return true;
    } catch {
      showError(`No response from server: ${nextServerName}.`);
      return false;
    }
  }, [replayServerName, servers, showError]);

  useEffect(() => {
    loadReplays();
  }, [loadReplays]);


  useEffect(() => {
    setRunParamValues((current) => ({
      ...current,
      ...hydrateRunParamValues(inputVariables, current),
    }));
  }, [inputVariables]);

  const applyRunStateToNodes = useCallback(
    (nextRun) => {
      setNodes((currentNodes) =>
        currentNodes.map((node) => {
          const nodeRun = nextRun.nodes?.[node.id];
          const result = nodeRun?.result;
          const outputColumns =
            result?.kind === "dataframe"
              ? (result.columns || []).map((column) => ({
                  name: column,
                  type: result.dtypes?.[column] || "unknown",
                }))
              : nodeRun?.columns
                ? (nodeRun.columns || []).map((column) => ({
                    name: column,
                    type: "unknown",
                  }))
                : node.data.outputColumns;

          return {
            ...node,
            data: {
              ...node.data,
              status: nodeRun?.status || node.data.status,
              outputColumns,
              runRows:
                nodeRun?.rows ??
                (result?.kind === "dataframe"
                  ? result.rows
                  : node.data.runRows),
              runDurationMs: nodeRun?.durationMs ?? node.data.runDurationMs,
              runLoopIterations:
                nodeRun?.loopIterations ?? node.data.runLoopIterations,
            },
          };
        }),
      );
    },
    [setNodes],
  );

  const updatePointerPosition = useCallback((event) => {
    pointerPositionRef.current = { x: event.clientX, y: event.clientY };
  }, []);

  const pointerFlowPosition = useCallback(() => {
    const pointer = pointerPositionRef.current;
    const instance = reactFlowRef.current;
    const bounds = canvasRef.current?.getBoundingClientRect();
    const screenPoint =
      pointer ||
      (bounds
        ? {
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
          }
        : null);
    if (!screenPoint || !instance) return { x: 0, y: 0 };
    if (instance.screenToFlowPosition) {
      return instance.screenToFlowPosition(screenPoint);
    }
    if (instance.project && bounds) {
      return instance.project({
        x: screenPoint.x - bounds.left,
        y: screenPoint.y - bounds.top,
      });
    }
    return { x: 0, y: 0 };
  }, []);

  const copySelectedGraph = useCallback(() => {
    const currentNodes = reactFlowRef.current?.getNodes?.() || nodes;
    const currentEdges = reactFlowRef.current?.getEdges?.() || edges;
    const fragment = selectedGraphFragment(
      currentNodes,
      currentEdges,
      currentNodes.filter((node) => node.selected).map((node) => node.id),
    );
    if (!fragment) return false;
    graphClipboardRef.current = cloneValue(fragment);
    return true;
  }, [edges, nodes]);

  const pasteGraph = useCallback(() => {
    const fragment = graphClipboardRef.current;
    if (!fragment?.nodes?.length) return false;

    const target = pointerFlowPosition();
    const anchor = {
      x: snapToConcertGrid(target.x),
      y: snapToConcertGrid(target.y),
    };
    const idMap = new Map();
    const usedNodeIds = new Set(nodes.map((node) => node.id));
    const newNodes = fragment.nodes.map((node) => {
      const nextId = makeUniqueNodeId(node.type || "node", usedNodeIds);
      idMap.set(node.id, nextId);
      return {
        ...node,
        id: nextId,
        position: {
          x: anchor.x + (node.position?.x ?? 0) - fragment.anchor.x,
          y: anchor.y + (node.position?.y ?? 0) - fragment.anchor.y,
        },
        selected: true,
        data: cleanNodeDataForSave(cloneValue(node.data || {})),
      };
    });
    const newEdges = fragment.edges.flatMap((edge) => {
      const source = idMap.get(edge.source);
      const target = idMap.get(edge.target);
      if (!source || !target) return [];
      return normalizeEdge({
        ...edge,
        source,
        target,
        selected: false,
        data: cloneValue(edge.data || {}),
      });
    });

    pushHistory(`Paste nodes: ${newNodes.length}`);
    setIsDirty(true);
    const nextNodes = [
      ...graphRef.current.nodes.map((node) => ({ ...node, selected: false })),
      ...newNodes,
    ];
    const nextEdges = [
      ...graphRef.current.edges.map((edge) => ({ ...edge, selected: false })),
      ...newEdges,
    ];
    graphRef.current = { nodes: nextNodes, edges: nextEdges };
    setNodes(nextNodes);
    setEdges(nextEdges);
    setEditData(null);
    setSearchHighlight(null);
    setContextMenu(null);
    return true;
  }, [nodes, pointerFlowPosition, pushHistory, setEdges, setNodes]);

  useEffect(() => {
    if (!activeRunId) return undefined;
    const controller = new AbortController();
    let pollTimer = null;
    const loadCompletedRun = async () => {
      try {
        const endpoint = `${apiBaseUrl}/runs/${activeRunId}?concertName=${encodeURIComponent(currentReplayConcertName)}`;
        const response = await fetch(endpoint, { signal: controller.signal });
        if (!response.ok) throw new Error(await responseErrorMessage(response));
        const nextRun = await response.json();
        if (["queued", "running"].includes(nextRun.status)) {
          setRun(nextRun);
          applyRunStateToNodes(nextRun);
          pollTimer = window.setTimeout(loadCompletedRun, 500);
          return;
        }
        const failedNodeError = Object.values(nextRun.nodes || {}).find(
          (nodeRun) => nodeRun?.status === "error" && nodeRun?.error,
        )?.error;
        const completedRun = nextRun.status === "error"
          ? { ...nextRun, error: nextRun.error || failedNodeError || "The backend reported that the run failed." }
          : nextRun;
        setRun(completedRun);
        applyRunStateToNodes(nextRun);
        setActiveRunId(null);
        if (nextRun.status === "success") setRunCompleteTiming(nextRun.timing || {});
        loadReplays();
      } catch (error) {
        if (error.name === "AbortError") return;
        const message = `Run status check failed: ${error.message}`;
        setRun((currentRun) => ({ ...currentRun, status: "error", error: message }));
        setNodes((currentNodes) => currentNodes.map((node) => node.data.status === "pending" || node.data.status === "running"
          ? { ...node, data: { ...node.data, status: "error" } }
          : node));
        setActiveRunId(null);
      }
    };
    loadCompletedRun();
    return () => {
      controller.abort();
      if (pollTimer) window.clearTimeout(pollTimer);
    };
  }, [activeRunId, apiBaseUrl, applyRunStateToNodes, currentReplayConcertName, loadReplays, setNodes]);

  useEffect(() => {
    const trackCanvasFocus = (event) => {
      isCanvasFocusedRef.current = Boolean(
        canvasRef.current?.contains(event.target),
      );
    };
    document.addEventListener("pointerdown", trackCanvasFocus, true);
    return () => document.removeEventListener("pointerdown", trackCanvasFocus, true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      const isSaveShortcut =
        (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s";
      const isOpenShortcut =
        (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o";
      const isUndoShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "z";
      const isRedoShortcut =
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "z";
      const isCopyShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c";
      const isPasteShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "v";
      const isSelectAllShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        event.key.toLowerCase() === "a";

      if (
        (isUndoShortcut ||
          isRedoShortcut ||
          isCopyShortcut ||
          isPasteShortcut ||
          isSelectAllShortcut) &&
        isTextEditingTarget(event.target)
      ) {
        return;
      }

      if (isSelectAllShortcut && editData) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (isSaveShortcut) {
        event.preventDefault();
        event.stopPropagation();
        void saveConcertLocal().catch((error) => {
          if (error?.name !== "AbortError") showError(`Save Concert failed: ${error.message}`);
        });
        return;
      }

      if (isOpenShortcut) {
        event.preventDefault();
        event.stopPropagation();
        void openConcertLocal().catch((error) => {
          if (error?.name !== "AbortError") showError(`Open Concert failed: ${error.message}`);
        });
        return;
      }

      if (isUndoShortcut) {
        event.preventDefault();
        event.stopPropagation();
        undo();
        return;
      }

      if (isRedoShortcut) {
        event.preventDefault();
        event.stopPropagation();
        redo();
        return;
      }

      if (isCopyShortcut) {
        if (!isCanvasFocusedRef.current) {
          return;
        }
        if (hasOutputTextSelection() || hasPyomoCodeTextSelection()) {
          return;
        }
        if (copySelectedGraph()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (isPasteShortcut) {
        if (pasteGraph()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }

      if (isSelectAllShortcut) {
        event.preventDefault();
        event.stopPropagation();
        setNodes((currentNodes) =>
          currentNodes.map((node) => ({ ...node, selected: true })),
        );
        setEdges((currentEdges) =>
          currentEdges.map((edge) => ({ ...edge, selected: true })),
        );
        setEditData(null);
        setSearchHighlight(null);
        setContextMenu(null);
        return;
      }

      if (
        (event.key === " " || event.code === "Space") &&
        !event.repeat &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        selectedNode &&
        selectedNode.type !== "text" &&
        !editData &&
        !isTextEditingTarget(event.target)
      ) {
        event.preventDefault();
        event.stopPropagation();
        void viewNodeDataRef.current?.(selectedNode);
        return;
      }

      if (event.key === "Escape") {
        if (document.querySelector(".concert-picker")) {
          return;
        }
        if (document.querySelector(".deploy-dialog")) {
          return;
        }
        if (document.querySelector(".concert-manager")) {
          return;
        }
        if (document.querySelector(".stage-resources-dialog")) {
          return;
        }
        if (document.querySelector(".variable-editor-panel")) {
          return;
        }
        if (document.querySelector(".opl-code-dialog")) {
          return;
        }
        if (isMonacoSuggestVisible()) {
          return;
        }
        if (selectedNode && hasEditorChanges(selectedNode, editData)) {
          event.preventDefault();
          event.stopPropagation();
          setIsSaveChangesDialogOpen(true);
          return;
        }
        clearNodeSelection();
        setEditData(null);
        setSearchHighlight(null);
        setContextMenu(null);
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    clearNodeSelection,
    copySelectedGraph,
    edges,
    editData,
    nodes,
    openConcertLocal,
    pasteGraph,
    redo,
    saveConcertLocal,
    selectedNode,
    showError,
    setEdges,
    setNodes,
    undo,
  ]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Shift") setIsConnectMode(true);
    };
    const onKeyUp = (event) => {
      if (event.key === "Shift") setIsConnectMode(false);
    };
    const onBlur = () => setIsConnectMode(false);

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const snapTextNodeSize = useCallback(
    (nodeId, size) => {
      const snapPosition = (value) =>
        Math.round(Number(value || 0) / 100) * 100;
      const snapSize = (value) =>
        Math.max(100, Math.round(Number(value || 0) / 100) * 100);
      const nextNodes = graphRef.current.nodes.map((node) =>
        node.id === nodeId && node.type === "text"
          ? {
              ...node,
              position: { x: snapPosition(size.x), y: snapPosition(size.y) },
              width: snapSize(size.width),
              height: snapSize(size.height),
              style: {
                ...(node.style || {}),
                width: snapSize(size.width),
                height: snapSize(size.height),
              },
            }
          : node,
      );
      graphRef.current = { ...graphRef.current, nodes: nextNodes };
      setNodes(nextNodes);
      setIsDirty(true);
    },
    [setNodes],
  );

  const flowNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        zIndex: node.type === "text" ? 0 : regularNodeZIndex,
        data: {
          ...node.data,
          isConnectMode,
        },
      })),
    [isConnectMode, nodes],
  );
  const flowEdges = useMemo(
    () => edges.map((edge) => ({ ...edge, zIndex: edgeZIndex })),
    [edges],
  );
  const disabledPaletteTypes = useMemo(() => {
    const disabled = new Set();
    if (nodes.some((node) => node.type === "concertInput")) {
      disabled.add("concertInput");
    }
    if (nodes.some((node) => node.type === "concertOutput")) {
      disabled.add("concertOutput");
    }
    return disabled;
  }, [nodes]);

  const dataframeColumnsForNode = useCallback(
    (nodeId, edgeList = edges) => {
      const visited = new Set();
      const stack = [{ nodeId, edgeColumns: [] }];
      while (stack.length) {
        const current = stack.pop();
        if (current.edgeColumns.length) return current.edgeColumns;
        if (!current.nodeId || visited.has(current.nodeId)) continue;
        visited.add(current.nodeId);
        const node = nodes.find((item) => item.id === current.nodeId);
        const result = run?.nodes?.[current.nodeId]?.result;
      if (result?.kind === "dataframe") {
        const resultColumns = (result.columns || []).map((column) => ({
          name: column,
          type: result.dtypes?.[column] || "unknown",
        }));
          if (resultColumns.length) return resultColumns;
      }

        const nodeColumns = normalizeColumnMetadata(node?.data?.outputColumns || []);
        if (nodeColumns.length) return nodeColumns;
        if (node?.type === "cacheRead") continue;

        const incomingEdges = edgeList.filter((edge) => edge.target === current.nodeId);
        for (let index = incomingEdges.length - 1; index >= 0; index -= 1) {
          const edge = incomingEdges[index];
          stack.push({
            nodeId: edge.source,
            edgeColumns: normalizeColumnMetadata(edge.data?.columns || []),
          });
        }
      }
      return [];
    },
    [edges, nodes, run],
  );

  const selectedInputDataframes = useMemo(() => {
    if (!selectedNode) return [];

    return edges
      .filter((edge) => edge.target === selectedNode.id)
      .map((edge, index) => {
        const sourceNode = nodes.find((node) => node.id === edge.source);
        const edgeColumns = normalizeColumnMetadata(edge.data?.columns || []);
        const columns = edgeColumns.length
          ? edgeColumns
          : dataframeColumnsForNode(edge.source);

        return {
          id: edge.source,
          name:
            sourceNode?.data?.name || sourceNode?.id || `input_${index + 1}`,
          status: run?.nodes?.[edge.source]?.status || "not_run",
          columns,
        };
      });
  }, [dataframeColumnsForNode, edges, nodes, run, selectedNode]);

  const selectedLoopIterationMode = useMemo(() => {
    if (selectedNode?.type !== "loopOut") return "allRows";
    const queue = edges
      .filter((edge) => edge.target === selectedNode.id)
      .map((edge) => edge.source);
    const visited = new Set();
    while (queue.length) {
      const nodeId = queue.shift();
      if (!nodeId || visited.has(nodeId)) continue;
      visited.add(nodeId);
      const node = nodes.find((item) => item.id === nodeId);
      if (node?.type === "loopIn") {
        return node.data?.iterationMode || "allRows";
      }
      edges
        .filter((edge) => edge.target === nodeId)
        .forEach((edge) => queue.push(edge.source));
    }
    return "allRows";
  }, [edges, nodes, selectedNode]);

  const selectedOutputColumns = useMemo(() => {
    if (!selectedNode) return [];
    const hasEditedOutputColumns =
      editData &&
      Object.prototype.hasOwnProperty.call(editData, "outputColumns");
    if (selectedNode.type !== "dbWrite" && hasEditedOutputColumns) {
      return normalizeColumnMetadata(editData.outputColumns || []);
    }
    const result = run?.nodes?.[selectedNode.id]?.result;
    if (result?.kind === "dataframe") {
      return (result.columns || []).map((column) => ({
        name: column,
        type: result.dtypes?.[column] || "unknown",
      }));
    }
    if (selectedNode.type === "dbWrite") {
      return selectedInputDataframes[0]?.columns || [];
    }
    return normalizeColumnMetadata(
      editData?.outputColumns || selectedNode.data?.outputColumns || [],
    );
  }, [editData, run, selectedInputDataframes, selectedNode]);

  const selectedOutputMessage = useMemo(() => {
    if (!selectedNode) return "";
    if (selectedOutputColumns.length) return "";
    if (selectedNode.type === "python")
      return "Run this node to inspect output columns.";
    if (selectedNode.type === "dbRead") return "No result columns.";
    if (selectedNode.type === "dbWrite")
      return "Connect an input DataFrame to inspect columns.";
    return "";
  }, [selectedNode, selectedOutputColumns.length]);

  const onConnect = useCallback(
    (params) => {
      if (!params.source || !params.target || params.source === params.target)
        return;
      const sourceNode = nodes.find((node) => node.id === params.source);
      const targetNode = nodes.find((node) => node.id === params.target);
      if (
        sourceNode?.type === "text" ||
        targetNode?.type === "text" ||
        noChildSourceTypes.has(sourceNode?.type) ||
        noParentTargetTypes.has(targetNode?.type)
      ) {
        return;
      }
      pushHistory(
        `Add edge: ${nodeNameById(params.source)} -> ${nodeNameById(params.target)}`,
      );
      setIsDirty(true);
      const currentEdges = graphRef.current.edges;
      const replacesExistingParent = singleParentTargetTypes.has(targetNode?.type);
      const retainedEdges = currentEdges.filter(
        (edge) =>
          !isSameNodePair(edge, params.source, params.target) &&
          !(replacesExistingParent && edge.target === params.target),
      );
      const edge = normalizeEdge({
        ...params,
        data: {
          columns: dataframeColumnsForNode(params.source, currentEdges),
        },
      });
      const nextEdges = addEdge(edge, retainedEdges);
      graphRef.current = { ...graphRef.current, edges: nextEdges };
      setEdges(nextEdges);
    },
    [dataframeColumnsForNode, nodeNameById, nodes, pushHistory, setEdges],
  );

  const handleNodesChange = useCallback(
    (changes) => {
      const positionChanges = changes.filter((change) => change.type === "position");
      const hasActualPositionChange = positionChanges.some((change) => {
        if (!change.position) return false;
        const currentNode = graphRef.current.nodes.find(
          (node) => node.id === change.id,
        );
        return (
          currentNode &&
          (currentNode.position?.x !== change.position.x ||
            currentNode.position?.y !== change.position.y)
        );
      });
      if (hasActualPositionChange && !nodeMoveHistoryRef.current) {
        nodeMoveHistoryRef.current = stateForHistory(graphRef.current, globalVariables, inputVariables);
      }
      const textDimensionChanges = changes.filter((change) => {
        if (change.type !== "dimensions" || !change.dimensions) return false;
        const currentNode = graphRef.current.nodes.find(
          (node) => node.id === change.id && node.type === "text",
        );
        if (!currentNode) return false;
        const currentWidth = currentNode.width || currentNode.style?.width || 200;
        const currentHeight = currentNode.height || currentNode.style?.height || 200;
        return (
          currentWidth !== change.dimensions.width ||
          currentHeight !== change.dimensions.height
        );
      });
      if (textDimensionChanges.length && !nodeResizeHistoryRef.current) {
        nodeResizeHistoryRef.current = stateForHistory(
          graphRef.current,
          globalVariables,
          inputVariables,
        );
      }
      const removedNodeIds = changes
        .filter((change) => change.type === "remove")
        .map((change) => change.id);
      const otherChanges = changes.filter(
        (change) => !["select", "dimensions", "position", "remove"].includes(change.type),
      );
      if (removedNodeIds.length || otherChanges.length) {
        const label =
          removedNodeIds.length === 1
            ? `Delete node: ${nodeNameById(removedNodeIds[0])}`
            : removedNodeIds.length
              ? `Delete nodes: ${removedNodeIds.map(nodeNameById).join(", ")}`
              : "Change nodes";
        pushHistory(label);
        suppressNextEdgeHistoryRef.current = true;
        window.setTimeout(() => {
          suppressNextEdgeHistoryRef.current = false;
        }, 0);
      }
      if (
        hasConcertNodeChange(changes) ||
        hasActualPositionChange ||
        textDimensionChanges.length
      ) {
        setIsDirty(true);
      }
      const nextNodes = applyNodeChanges(changes, graphRef.current.nodes).map(
        (node) =>
          node.type === "text"
            ? {
                ...node,
                zIndex: 0,
                style: {
                  ...(node.style || {}),
                  width: node.width || node.style?.width || 200,
                  height: node.height || node.style?.height || 200,
                },
              }
            : { ...node, zIndex: regularNodeZIndex },
      );
      graphRef.current = { ...graphRef.current, nodes: nextNodes };
      setNodes(nextNodes);
      if (
        nodeMoveHistoryRef.current &&
        positionChanges.some((change) => change.dragging !== true)
      ) {
        pushHistory("Move nodes", nodeMoveHistoryRef.current);
        nodeMoveHistoryRef.current = null;
      }
      if (
        nodeResizeHistoryRef.current &&
        changes.some(
          (change) =>
            change.type === "dimensions" && change.resizing === false,
        )
      ) {
        pushHistory("Resize text node", nodeResizeHistoryRef.current);
        nodeResizeHistoryRef.current = null;
      }
    },
    [globalVariables, inputVariables, nodeNameById, pushHistory, setNodes],
  );

  const handleEdgesChange = useCallback(
    (changes) => {
      const removedEdgeIds = changes
        .filter((change) => change.type === "remove")
        .map((change) => change.id);
      const otherChanges = changes.filter(
        (change) => !["select", "remove"].includes(change.type),
      );
      if ((removedEdgeIds.length || otherChanges.length) && !suppressNextEdgeHistoryRef.current) {
        const label =
          removedEdgeIds.length === 1
            ? `Delete edge: ${edgeLabelById(removedEdgeIds[0])}`
            : removedEdgeIds.length
              ? `Delete edges: ${removedEdgeIds.map(edgeLabelById).join(", ")}`
              : "Change edges";
        pushHistory(label);
      }
      if (hasConcertEdgeChange(changes)) setIsDirty(true);
      const nextEdges = applyEdgeChanges(changes, graphRef.current.edges);
      graphRef.current = { ...graphRef.current, edges: nextEdges };
      setEdges(nextEdges);
    },
    [edgeLabelById, pushHistory, setEdges],
  );

  const addNode = useCallback(
    (type, position = null) => {
      if (
        ["concertInput", "concertOutput"].includes(type) &&
        graphRef.current.nodes.some((node) => node.type === type)
      ) {
        return;
      }
      const currentNodes = graphRef.current.nodes;
      const newNode = createNode(
        type,
        currentNodes.length + 1,
        position || {
          x: 100 + (currentNodes.length % 4) * 200,
          y: 100 + Math.floor(currentNodes.length / 4) * 200,
        },
      );
      pushHistory(`Add node: ${newNode.data.name}`);
      setIsDirty(true);
      const nextNodes = [
        ...currentNodes,
        newNode,
      ];
      graphRef.current = { ...graphRef.current, nodes: nextNodes };
      setNodes(nextNodes);
    },
    [pushHistory, setNodes],
  );

  const onCanvasDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onCanvasDrop = useCallback(
    (event) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/metronome-node");
      if (!type || !reactFlowRef.current) return;
      if (
        ["concertInput", "concertOutput"].includes(type) &&
        nodes.some((node) => node.type === type)
      ) {
        return;
      }

      const bounds = event.currentTarget.getBoundingClientRect();
      const position = reactFlowRef.current.project({
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
      });
      addNode(type, position);
    },
    [addNode, nodes],
  );

  const onViewportMoveEnd = useCallback(
    (_, viewport) => {
      if (!viewport) return;
      viewportRef.current = viewport;
      if (!activeTabId) return;
      setTabs((current) =>
        current.map((tab) =>
          tab.id === activeTabId
            ? { ...tab, viewport: cloneValue(viewport) }
            : tab,
        ),
      );
    },
    [activeTabId],
  );

  const updateSearchHeight = useCallback(
    (height) => {
      setSearchHeight(height);
      if (!activeTabId) return;
      setTabs((current) =>
        current.map((tab) =>
          tab.id === activeTabId ? { ...tab, searchHeight: height } : tab,
        ),
      );
    },
    [activeTabId],
  );

  useEffect(() => {
    const onPointerMove = (event) => {
      if (!bottomPanelDragRef.current) return;
      event.preventDefault();
      const delta = bottomPanelDragRef.current.y - event.clientY;
      const nextHeight = Math.min(
        520,
        Math.max(140, bottomPanelDragRef.current.height + delta),
      );
      updateSearchHeight(nextHeight);
    };

    const onPointerUp = () => {
      bottomPanelDragRef.current = null;
      document.body.classList.remove("resizing-concert-bottom-panel");
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.classList.remove("resizing-concert-bottom-panel");
    };
  }, [updateSearchHeight]);

  const closeEditor = useCallback(() => {
    clearNodeSelection();
    setEditData(null);
    setSearchHighlight(null);
    setIsSaveChangesDialogOpen(false);
  }, [clearNodeSelection]);

  const requestEditorClose = useCallback(() => {
    if (selectedNode && hasEditorChanges(selectedNode, editData)) {
      setIsSaveChangesDialogOpen(true);
      return;
    }
    closeEditor();
  }, [closeEditor, editData, selectedNode]);

  const openEditor = (_, node) => {
    setContextMenu(null);
    setIsSaveChangesDialogOpen(false);
    selectOnlyNode(node.id);
    setEditData(editableNodeData(node));
    setSearchHighlight(null);
  };

  const openSearchResult = (result, action = "open") => {
    const target = nodes.find((node) => node.id === result.nodeId);
    if (!target) return;

    const width = target.width || target.measured?.width || 180;
    const height = target.height || target.measured?.height || 80;
    const currentZoom = reactFlowRef.current?.getZoom?.();
    const centerOptions = { duration: 450 };
    if (Number.isFinite(currentZoom)) {
      centerOptions.zoom = currentZoom;
    }
    reactFlowRef.current?.setCenter?.(
      (target.position?.x || 0) + width / 2,
      (target.position?.y || 0) + height / 2,
      centerOptions,
    );

    setNodes((currentNodes) =>
      currentNodes.map((node) => ({
        ...node,
        selected: node.id === result.nodeId,
      })),
    );
    setContextMenu(null);
    setIsSaveChangesDialogOpen(false);
    if (action !== "open") {
      setEditData(null);
      setSearchHighlight(null);
      return;
    }

    setEditData(editableNodeData(target));
    setSearchHighlight(
      ["sql", "code"].includes(result.field)
        ? {
            nodeId: result.nodeId,
            field: result.field,
            lineNumber: result.lineNumber,
            startColumn: result.startColumn,
            endColumn: result.endColumn,
            term: result.term,
            token: `${result.id}:${Date.now()}`,
          }
        : null,
    );
  };

  const setBottomPanelState = (nextState) => {
    setIsSearchVisible(nextState.isSearchVisible);
    setIsOutputVisible(nextState.isOutputVisible);
    setActiveBottomPanel(nextState.activeBottomPanel);
    if (!activeTabId) return;
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTabId
          ? {
              ...tab,
              isSearchVisible: nextState.isSearchVisible,
              isOutputVisible: nextState.isOutputVisible,
              activeBottomPanel: nextState.activeBottomPanel,
            }
          : tab,
      ),
    );
  };

  const toggleSearchPanel = () => {
    const nextSearchVisible = !isSearchVisible;
    setBottomPanelState({
      isSearchVisible: nextSearchVisible,
      isOutputVisible,
      activeBottomPanel: nextSearchVisible
        ? "search"
        : isOutputVisible
          ? "output"
          : "search",
    });
  };

  const toggleOutputPanel = () => {
    const nextOutputVisible = !isOutputVisible;
    setBottomPanelState({
      isSearchVisible,
      isOutputVisible: nextOutputVisible,
      activeBottomPanel: nextOutputVisible
        ? "output"
        : isSearchVisible
          ? "search"
          : "output",
    });
  };

  const selectBottomPanel = (panel) => {
    setActiveBottomPanel(panel);
    if (!activeTabId) return;
    setTabs((current) =>
      current.map((tab) =>
        tab.id === activeTabId ? { ...tab, activeBottomPanel: panel } : tab,
      ),
    );
  };

  const saveEditor = async () => {
    if (!selectedNode || !editData) return;
    let nodeName;
    try {
      nodeName = validateNodeName(editData.name);
      if (
        ["cacheRead", "cacheWrite"].includes(selectedNode.type) &&
        (editData.scope || "stage") === "concert"
      ) {
        validateCacheName(editData.resourceName);
      }
    } catch (error) {
      showError(error.message);
      return;
    }
    const hasChanges = hasEditorChanges(selectedNode, editData);
    let nextEditData = editData;
    if (selectedNode.type === "concert") {
      try {
        if (editData.concertInputsLoading) {
          throw new Error("Wait for the selected Concert input definitions to finish loading.");
        }
        if (!editData.concertName) {
          throw new Error("Select a Concert before saving the Concert Call node.");
        }
        if (editData.concertLoadError) {
          throw new Error(editData.concertLoadError);
        }
        nextEditData = {
          ...editData,
          concertLoadError: undefined,
          inputParams: Object.fromEntries(
            Object.entries(editData.inputParamValues || {}).map(
              ([key, value]) => {
                const definition = (editData.calledConcertInputVariables || []).find(
                  (item) => normalizeVariableName(item.name).replace(/^\$+/, "") === key.replace(/^\$+/, ""),
                );
                if (!definition) throw new Error(`Input variable definition not found: $${key.replace(/^\$+/, "")}`);
                return [key, coerceVariableValue(value, definition.type, `$${key.replace(/^\$+/, "")}`)];
              },
            ),
          ),
        };
      } catch (error) {
        showError(`Save Concert Call failed: ${error.message}`);
        return;
      }
      if (nextEditData.concertName === concertName) {
        setRun({
          status: "error",
          nodes: {},
          error: "Concert call node cannot call the current Concert.",
        });
        return;
      }
    }
    const nextNodes = nodes.map((node) =>
        node.id === selectedNode.id
          ? {
              ...node,
              data: {
                ...node.data,
                ...nextEditData,
                name: nodeName,
              },
            }
          : node,
      );
    const nextEdges = edges;
    const changed = hasChanges;
    if (changed) {
      pushHistory(`Edit node: ${selectedNode.data?.name || selectedNode.id}`);
      setIsDirty(true);
    }
    graphRef.current = { nodes: nextNodes, edges: nextEdges };
    setNodes(nextNodes);
    setEditData(null);
    setSearchHighlight(null);
    setIsSaveChangesDialogOpen(false);
    if (changed && selectedNode.type !== "text") {
      try {
        const inferred = await inferConcertColumns(
          nextNodes,
          nextEdges,
          globalVariables,
          inputVariables,
          selectedNode.id,
        );
        graphRef.current = { nodes: inferred.nodes, edges: inferred.edges };
        setNodes(inferred.nodes);
        setEdges(inferred.edges);
      } catch (error) {
        setRun({ status: "error", nodes: {}, error: error.message });
      }
    }
  };

  const onNodeContextMenu = (event, node) => {
    event.preventDefault();
    selectOnlyNode(node.id);
    setContextMenu({ node, x: event.clientX, y: event.clientY });
  };

  const moveTextNodeLayer = useCallback(
    (nodeId, toFront) => {
      const currentNodes = graphRef.current.nodes;
      const textNodes = currentNodes
        .filter((node) => node.type === "text");
      const targetIndex = textNodes.findIndex((node) => node.id === nodeId);
      if (targetIndex < 0) return;
      if (
        (toFront && targetIndex === textNodes.length - 1) ||
        (!toFront && targetIndex === 0)
      ) {
        setContextMenu(null);
        return;
      }
      const [target] = textNodes.splice(targetIndex, 1);
      if (toFront) textNodes.push(target);
      else textNodes.unshift(target);
      pushHistory(
        `${toFront ? "Bring to Front" : "Send to Back"}: ${target.data?.name || nodeId}`,
      );
      const regularNodes = currentNodes.filter((node) => node.type !== "text");
      const nextNodes = [
        ...textNodes.map((node) => ({ ...node, zIndex: 0 })),
        ...regularNodes.map((node) => ({ ...node, zIndex: regularNodeZIndex })),
      ];
      graphRef.current = { ...graphRef.current, nodes: nextNodes };
      setNodes(nextNodes);
      setIsDirty(true);
      setContextMenu(null);
    },
    [pushHistory, setNodes],
  );

  const viewNodeData = useCallback(
    async (node) => {
      const existingNodeRun = run?.nodes?.[node.id];
      const runId = lastRunId || run?.id;
      if (!runId) {
        openDataWindow(node, existingNodeRun);
        return;
      }
      const queryUrl = `${apiBaseUrl}/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(node.id)}/data/query?concertName=${encodeURIComponent(currentReplayConcertName)}`;
      try {
        const response = await fetch(queryUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ offset: 0, limit: 1000 }),
        });
        if (!response.ok) throw new Error(await response.text());
        const body = await response.json();
        openDataWindow(
          node,
          { ...(existingNodeRun || {}), result: body.result },
          null,
          { apiMode: true, queryUrl },
        );
      } catch (error) {
        openDataWindow(node, {
          ...(existingNodeRun || {}),
          error: `Load API data failed: ${error.message}`,
        });
      }
    },
    [apiBaseUrl, currentReplayConcertName, lastRunId, run],
  );
  useEffect(() => {
    viewNodeDataRef.current = viewNodeData;
  }, [viewNodeData]);

  const viewOplLp = useCallback(
    async (node, replayIdOverride = null) => {
      const viewer = window.open("", "_blank", "width=1100,height=760,resizable=yes,scrollbars=yes");
      if (!viewer) return;
      viewer.document.title = `${node.data.name} - LP Model`;
      viewer.document.body.replaceChildren();
      viewer.document.body.style.margin = "0";
      viewer.document.body.style.background = "#0f172a";
      const pre = viewer.document.createElement("pre");
      pre.style.margin = "0";
      pre.style.minHeight = "100vh";
      pre.style.boxSizing = "border-box";
      pre.style.color = "#e2e8f0";
      pre.style.font = "13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
      pre.style.padding = "18px";
      pre.style.whiteSpace = "pre";
      pre.style.userSelect = "text";
      pre.textContent = "Loading LP model...";
      viewer.document.body.appendChild(pre);

      const nodeRunStatus = run?.nodes?.[node.id]?.status;
      const hasCurrentCache = Boolean(
        lastRunId && nodeRunStatus === "success",
      );
      const query = new URLSearchParams({
        concertName: currentReplayConcertName,
        nodeId: node.id,
        format: "lp",
      });
      if (hasCurrentCache) query.set("cacheId", lastRunId);
      const resolvedReplayId = replayIdOverride || selectedReplayId;
      if (resolvedReplayId) query.set("replayId", resolvedReplayId);
      try {
        const replayPoint = visibleReplays.find(
          (item) => item.id === resolvedReplayId,
        );
        const modelApiBaseUrl = hasCurrentCache
          ? apiBaseUrl
          : replayPoint?.replayApiBaseUrl || apiBaseUrl;
        const response = await fetch(`${modelApiBaseUrl}/opl/model?${query.toString()}`);
        if (!response.ok) throw new Error(await response.text());
        pre.textContent = await response.text();
      } catch (error) {
        pre.textContent = `Load LP failed: ${error.message}`;
        pre.style.color = "#fecaca";
      }
    },
    [apiBaseUrl, currentReplayConcertName, lastRunId, run, selectedReplayId, visibleReplays],
  );

  const openReplayCache = useCallback(
    async (replay) => {
      if (!replay?.cache?.available) return;
      try {
        const sourceApiBaseUrl = replay.replayApiBaseUrl || replayApiBaseUrl;
        const response = await fetch(
          `${sourceApiBaseUrl}/replays/cache?concertName=${encodeURIComponent(replay.concertName)}&replayId=${encodeURIComponent(replay.id)}`,
        );
        if (!response.ok) {
          setRun({
            status: "error",
            nodes: {},
            error: await response.text(),
          });
          return;
        }
        const body = await response.json();
        if (!body.caches?.length) throw new Error("No Run Cache found.");
        setRunCacheSelection({ replay, caches: body.caches });
      } catch (error) {
        setRun({
          status: "error",
          nodes: {},
          error: `Open cache failed: ${error.message}`,
        });
      }
    },
    [replayApiBaseUrl],
  );

  const openSelectedRunCache = useCallback(
    async (cacheId) => {
      const replay = runCacheSelection?.replay;
      if (!replay || !cacheId) return;
      try {
        const sourceApiBaseUrl = replay.replayApiBaseUrl || replayApiBaseUrl;
        const response = await fetch(
          `${sourceApiBaseUrl}/replays/cache/${encodeURIComponent(cacheId)}?concertName=${encodeURIComponent(replay.concertName)}&replayId=${encodeURIComponent(replay.id)}`,
        );
        if (!response.ok) throw new Error(await response.text());
        const body = await response.json();
        const nextRun = body.run;
        setRun(nextRun);
        setLastRunId(nextRun.id);
        setActiveRunId(null);
        applyRunStateToNodes(nextRun);
        setRunCacheSelection(null);
        setIsReplayDialogOpen(false);
      } catch (error) {
        setRun({ status: "error", nodes: {}, error: `Open cache failed: ${error.message}` });
      }
    },
    [applyRunStateToNodes, replayApiBaseUrl, runCacheSelection],
  );

  const deleteSelectedRunCache = useCallback(
    async (cacheId) => {
      const replay = runCacheSelection?.replay;
      if (!replay || !cacheId) return;
      if (!window.confirm(`Delete Run Cache ${cacheId}?`)) return;
      try {
        const sourceApiBaseUrl = replay.replayApiBaseUrl || replayApiBaseUrl;
        const response = await fetch(
          `${sourceApiBaseUrl}/replays/cache/${encodeURIComponent(cacheId)}?concertName=${encodeURIComponent(replay.concertName)}&replayId=${encodeURIComponent(replay.id)}`,
          { method: "DELETE" },
        );
        if (!response.ok) throw new Error(await response.text());
        setRunCacheSelection((current) => {
          if (!current) return null;
          const nextCaches = current.caches.filter(
            (cache) => cache.cacheId !== cacheId,
          );
          return nextCaches.length ? { ...current, caches: nextCaches } : null;
        });
        if (lastRunId === cacheId) {
          setLastRunId(null);
          setRun(null);
        }
        await loadReplays();
      } catch (error) {
        setRun({ status: "error", nodes: {}, error: `Delete cache failed: ${error.message}` });
      }
    },
    [lastRunId, loadReplays, replayApiBaseUrl, runCacheSelection],
  );

  const clearReplayCache = useCallback(
    async (replay) => {
      if (!replay?.cache?.available) return;
      try {
        const sourceApiBaseUrl = replay.replayApiBaseUrl || replayApiBaseUrl;
        const response = await fetch(
          `${sourceApiBaseUrl}/replays/cache?concertName=${encodeURIComponent(replay.concertName)}&replayId=${encodeURIComponent(replay.id)}`,
          { method: "DELETE" },
        );
        if (!response.ok) {
          setRun({
            status: "error",
            nodes: {},
            error: await response.text(),
          });
          return;
        }
        if (run?.cache?.enabled && run?.cache?.sourceReplayId === replay.id) {
          setLastRunId(null);
          setRun(null);
        }
        await loadReplays();
      } catch (error) {
        setRun({
          status: "error",
          nodes: {},
          error: `Clear cache failed: ${error.message}`,
        });
      }
    },
    [loadReplays, replayApiBaseUrl, run],
  );

  const closeReplayPoint = useCallback(() => {
    clearReplayState();
    setRun(null);
    setActiveRunId(null);
    setLastRunId(null);
    setRunCompleteTiming(null);
    setPendingRun(null);
    setEditData(null);
    setSearchHighlight(null);
    setContextMenu(null);
    setIsReplayDialogOpen(false);
    setNodes((currentNodes) =>
      currentNodes.map((node) => {
        const data = omitKeys(node.data, new Set([
          "runRows",
          "runDurationMs",
          "runLoopIterations",
        ]));
        return {
          ...node,
          selected: false,
          data: {
            ...data,
            status: "skipped",
          },
        };
      }),
    );
  }, [clearReplayState, setNodes]);

  const runConcert = async (
    mode,
    replay = false,
    runParams = null,
    skipPrompt = false,
  ) => {
    if (mode === "selected" && selectedNode?.type === "text") {
      setRun({
        status: "error",
        nodes: {},
        error: "Text nodes cannot be executed.",
      });
      return;
    }
    if (replay && !selectedReplayId) {
      setRun({
        status: "error",
        nodes: {},
        error: "Select replay data first.",
      });
      return;
    }

    if (!skipPrompt) {
      setPendingRun({ mode, replay });
      if (!replay) {
        setRunParamValues((current) =>
          hydrateRunParamValues(inputVariables, current),
        );
      }
      return;
    }

    let targetNodes;
    try {
      targetNodes = runTargetNodes(nodes, edges, mode, selectedNode?.id);
    } catch (error) {
      setActiveRunId(null);
      setRun({ status: "error", nodes: {}, error: error.message });
      return;
    }
    const validationErrors = validateRunNodes(targetNodes, edges);
    if (validationErrors.length) {
      const validationMessage = runValidationMessage(validationErrors);
      const errorsById = new Map(validationErrors.map((item) => [item.nodeId, item]));
      const failedNodes = Object.fromEntries(validationErrors.map((item) => [
        item.nodeId,
        {
          id: item.nodeId,
          name: item.nodeName,
          type: item.nodeType,
          status: "error",
          error: `Required settings are missing: ${item.fields.join(", ")}`,
        },
      ]));
      setNodes((currentNodes) => currentNodes.map((node) => (
        errorsById.has(node.id)
          ? { ...node, data: { ...node.data, status: "error" } }
          : node
      )));
      setActiveRunId(null);
      setRun({
        status: "error",
        nodes: failedNodes,
        error: validationMessage,
      });
      showError(validationMessage);
      return;
    }

    const runConcertName = safeConcertPathName(concertName);
    try {
      await validateCalledConcerts(targetNodes);
    } catch (error) {
      if (error?.name === "AbortError") return;
      setRun({
        status: "error",
        nodes: {},
        error: `Prepare Concert failed: ${error.message}`,
      });
      return;
    }

    const nextNodes = nodes.map((node) =>
      node.type === "text"
        ? node
        : {
            ...node,
            data: {
              ...node.data,
              status: mode === "selected" ? "skipped" : "pending",
              runRows: null,
              runDurationMs: null,
              runLoopIterations: null,
            },
          },
    );
    const nextEdges = edges.map(normalizeEdge);
    setNodes(nextNodes);
    setEdges(nextEdges);
    setRun(null);
    setActiveRunId(null);
    setRunCompleteTiming(null);

    const replayPoint = visibleReplays.find(
      (replayItem) => replayItem.id === selectedReplayId,
    );
    const inputParams =
      runParams || (replay ? replayPoint?.params || {} : runParamValues);

    try {
      let executionReplayId = selectedReplayId;
      if (
        replay &&
        replayPoint?.replayApiBaseUrl &&
        replayPoint.replayApiBaseUrl !== apiBaseUrl
      ) {
        const transferQuery = new URLSearchParams({
          concertName: replayPoint.concertName,
          replayId: replayPoint.id,
          sourceServerName: replayPoint.replayServerName,
        });
        const statusResponse = await fetch(
          `${apiBaseUrl}/replays/import-status?${transferQuery.toString()}`,
        );
        if (!statusResponse.ok) {
          throw new Error(`Replay import check failed: ${await responseErrorMessage(statusResponse)}`);
        }
        const importStatus = await statusResponse.json();
        executionReplayId = importStatus.replayId;
        if (!importStatus.exists) {
          const exportResponse = await fetch(
            `${replayPoint.replayApiBaseUrl}/replays/export?${transferQuery.toString()}`,
          );
          if (!exportResponse.ok) {
            throw new Error(`Replay download failed: ${await responseErrorMessage(exportResponse)}`);
          }
          const replayArchive = await exportResponse.blob();
          const importResponse = await fetch(
            `${apiBaseUrl}/replays/import?${transferQuery.toString()}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/zip" },
              body: replayArchive,
            },
          );
          if (!importResponse.ok) {
            throw new Error(`Replay import failed: ${await responseErrorMessage(importResponse)}`);
          }
          const importResult = await importResponse.json();
          executionReplayId = importResult.replayId;
        }
      }
      const graph = executableGraph(nextNodes, nextEdges);
      const response = await fetch(`${apiBaseUrl}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          concertName: runConcertName,
          concertId,
          nodes: graph.nodes,
          edges: graph.edges,
          globalVariables: variablePayload(globalVariables),
          inputVariables: variablePayload(inputVariables, "defaultValue"),
          params: typedParamPayload(inputParams, inputVariables),
          mode,
          selected: selectedNode?.id,
          replay,
          replayId: replay ? executionReplayId : null,
        }),
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      const body = await response.json();
      setRun(body);
      applyRunStateToNodes(body);
      setLastRunId(body.runId);
      setActiveRunId(body.runId);
    } catch (error) {
      const message = `Run failed: ${error.message}`;
      const failedNodes = Object.fromEntries(nextNodes.map((node) => [
        node.id,
        { id: node.id, name: node.data.name, status: "error", error: message },
      ]));
      setNodes((currentNodes) => currentNodes.map((node) => ({
        ...node,
        data: { ...node.data, status: "error" },
      })));
      setRun({ status: "error", nodes: failedNodes, error: message });
    }
  };

  const cancelRun = async () => {
    if (!activeRunId) return;
    try {
      const response = await fetch(`${apiBaseUrl}/runs/${activeRunId}/cancel`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await responseErrorMessage(response));
      setRun((currentRun) => ({ ...currentRun, status: "canceled" }));
      setRunCompleteTiming(null);
    } catch (error) {
      setRun({
        status: "error",
        nodes: {},
        error: `Cancel failed: ${error.message}`,
      });
    }
  };

  const confirmPendingRun = (draftValues = runParamValues) => {
    if (!pendingRun) return;
    const nextRun = pendingRun;
    let params = null;
    if (!nextRun.replay) {
      const nextValues = hydrateRunParamValues(inputVariables, draftValues);
      setRunParamValues(nextValues);
      params = typedParamPayload(nextValues, inputVariables);
    }
    setPendingRun(null);
    void runConcert(nextRun.mode, nextRun.replay, params, true);
  };

  useImperativeHandle(
    ref,
    () => ({
      newConcert: openNewTab,
      closeConcert,
      openConcert: () => {
        void openConcertLocal().catch((error) => {
          if (error?.name !== "AbortError") showError(`Open Concert failed: ${error.message}`);
        });
      },
      openServerConcert,
      openDeploymentConcert,
      saveConcert: () => {
        void saveConcertLocal().catch((error) => {
          if (error?.name !== "AbortError") showError(`Save Concert failed: ${error.message}`);
        });
      },
      saveConcertAs: () => {
        void saveConcertAsLocal().catch((error) => {
          if (error?.name !== "AbortError") showError(`Save Concert failed: ${error.message}`);
        });
      },
      prepareDeployment: async (nextVersion, deploymentName, nextCommitId) => {
        const commitOverrides = { lastCommitId, commitId: nextCommitId };
        return {
          ...concertPayload(concertBaseName(deploymentName), nextVersion),
          ...commitOverrides,
        };
      },
      completeDeployment: async (nextVersion, nextCommitId) => {
        await saveConcertLocal(nextVersion, null, {
          lastCommitId: nextCommitId,
          commitId: nextCommitId,
        });
      },
      activeConcertName: () => isTabOpen ? concertName : "",
      hasActiveConcert: () => isTabOpen,
    }),
    [closeConcert, concertName, concertPayload, isTabOpen, lastCommitId, openConcertLocal, openDeploymentConcert, openNewTab, openServerConcert, saveConcertAsLocal, saveConcertLocal, showError],
  );

  return (
    <div
      className="concert-tab-view"
      onDragOver={handleConcertFileDragOver}
      onDrop={handleConcertFileDrop}
      onClick={() => {
        setContextMenu(null);
        setActiveSubMenu(null);
      }}
    >
      <input
        ref={openInputRef}
        className="hidden-file-input"
        type="file"
        accept=".concert"
        onChange={handleFallbackOpen}
      />

      <section className={`concert-tab-shell ${isTabOpen ? "" : "empty"}`}>
        <div className="tab-strip">
          {tabs.map((tab) => (
            <button
              className={`tab-button ${tab.id === activeTabId ? "active" : ""}`}
              title={tab.concertFileLabel}
              key={tab.id}
              onClick={() => switchTab(tab.id)}
            >
              <span className="tab-title">
                {tab.concertName}
                {(tab.id === activeTabId ? isDirty : tab.isDirty) ? " *" : ""}
              </span>
              <span
                className="tab-close"
                role="button"
                tabIndex={0}
                title="Close"
                onClick={(event) => {
                  event.stopPropagation();
                  requestCloseTab(tab.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    requestCloseTab(tab.id);
                  }
                }}
              >
                x
              </span>
            </button>
          ))}
        </div>

        {isTabOpen ? (
          <>
            <div ref={subMenuRef} className="sub-toolbar">
              <div
                className="menu-root"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  className="menu-button"
                  onClick={() =>
                    setActiveSubMenu(activeSubMenu === "edit" ? null : "edit")
                  }
                >
                  Edit
                </button>
                {activeSubMenu === "edit" && (
                  <div className="menu-popover">
                    <button
                      disabled={!undoStack.length}
                      onClick={() => {
                        setActiveSubMenu(null);
                        undo();
                      }}
                    >
                      {nextUndoLabel ? `Undo: ${nextUndoLabel}` : "Undo"}
                    </button>
                    <button
                      disabled={!redoStack.length}
                      onClick={() => {
                        setActiveSubMenu(null);
                        redo();
                      }}
                    >
                      {nextRedoLabel ? `Redo: ${nextRedoLabel}` : "Redo"}
                    </button>
                    <button
                      onClick={() => {
                        setActiveSubMenu(null);
                        setIsVariablesDialogOpen(true);
                      }}
                    >
                      Variables
                    </button>
                  </div>
                )}
              </div>

              <div
                className="menu-root"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  className="menu-button"
                  onClick={() =>
                    setActiveSubMenu(activeSubMenu === "view" ? null : "view")
                  }
                >
                  View
                </button>
                {activeSubMenu === "view" && (
                  <div className="menu-popover">
                    <button
                      onClick={() => {
                        toggleSearchPanel();
                      }}
                    >
                      <span className="menu-check">
                        {isSearchVisible ? "✓" : ""}
                      </span>
                      Search
                    </button>
                    <button
                      onClick={() => {
                        toggleOutputPanel();
                      }}
                    >
                      <span className="menu-check">
                        {isOutputVisible ? "✓" : ""}
                      </span>
                      Output
                    </button>
                  </div>
                )}
              </div>

              <div className="toolbar-group replay-controls">
                <button
                  className="primary-button"
                  onClick={() => runConcert("all", false)}
                >
                  Run All
                </button>
                <button
                  disabled={!selectedNode || selectedNode.type === "text"}
                  onClick={() => runConcert("selected", false)}
                >
                  Run To Selected
                </button>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    setIsReplayDialogOpen(true);
                    void loadReplays();
                  }}
                >
                  Replay Points
                </button>
                <button
                  onClick={() => runConcert("all", true)}
                  disabled={!selectedReplayId}
                >
                  Replay Run
                </button>
                <button
                  onClick={() => runConcert("selected", true)}
                  disabled={!selectedNode || selectedNode.type === "text" || !selectedReplayId}
                >
                  Replay Run To Selected
                </button>
                <button
                  onClick={closeReplayPoint}
                  disabled={!selectedReplayId}
                >
                  Close Replay
                </button>
                <span
                  className={`selected-replay-chip ${selectedReplayLabel ? "" : "empty"}`}
                  title={selectedReplayLabel || "No replay point selected"}
                >
                  {selectedReplayLabel || "No replay"}
                </span>
              </div>
            </div>

            <div className="concert-workspace">
              <NodePalette disabledTypes={disabledPaletteTypes} />

              <div
                className={`concert-main-pane ${isSearchVisible || isOutputVisible ? "bottom-panel-visible" : ""}`}
                style={{
                  "--concert-bottom-panel-height": `${searchHeight}px`,
                }}
              >
                <div
                  ref={canvasRef}
                  className="canvas"
                  onDragOver={onCanvasDragOver}
                  onDrop={onCanvasDrop}
                >
                  <TextNodeResizeContext.Provider value={snapTextNodeSize}>
                    <ReactFlow
                    onInit={(instance) => {
                      reactFlowRef.current = instance;
                      instance.setViewport?.(viewportRef.current);
                    }}
                    nodes={flowNodes}
                    edges={flowEdges}
                    onNodesChange={handleNodesChange}
                    onEdgesChange={handleEdgesChange}
                    onConnect={onConnect}
                    onNodeDoubleClick={openEditor}
                    onNodeClick={() => setSearchHighlight(null)}
                    onNodeContextMenu={onNodeContextMenu}
                    onMoveEnd={onViewportMoveEnd}
                    onMouseMove={updatePointerPosition}
                    onPaneClick={() => {
                      setContextMenu(null);
                      clearNodeSelection();
                    }}
                    nodeTypes={nodeTypes}
                    edgeTypes={edgeTypes}
                    connectionMode={ConnectionMode.Loose}
                    defaultEdgeOptions={{
                      type: "center",
                      markerEnd: { type: MarkerType.ArrowClosed },
                      zIndex: edgeZIndex,
                    }}
                    snapToGrid
                    snapGrid={[100, 100]}
                    panOnScroll
                    panOnScrollMode={PanOnScrollMode.Free}
                    panOnScrollSpeed={0.8}
                    zoomOnScroll
                    panOnDrag={false}
                    selectionOnDrag
                    selectionKeyCode={null}
                    deleteKeyCode={["Backspace", "Delete"]}
                    selectionMode={SelectionMode.Full}
                    elevateNodesOnSelect={false}
                    onlyRenderVisibleElements
                    minZoom={0.1}
                  >
                    <Background variant="lines" gap={100} size={1} />
                    <Controls />
                    </ReactFlow>
                  </TextNodeResizeContext.Provider>
                </div>

                {(isSearchVisible || isOutputVisible) && (
                  <div
                    className="concert-bottom-panel"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <div
                      className="concert-bottom-panel-resizer"
                      onPointerDown={(event) => {
                        event.preventDefault();
                        bottomPanelDragRef.current = {
                          y: event.clientY,
                          height: searchHeight,
                        };
                        document.body.classList.add(
                          "resizing-concert-bottom-panel",
                        );
                      }}
                      title="Resize bottom panel"
                    />
                    <div className="concert-bottom-tabs">
                      {isSearchVisible && (
                        <button
                          className={`concert-bottom-tab ${activeBottomPanel === "search" ? "active" : ""}`}
                          onClick={() => selectBottomPanel("search")}
                        >
                          Search
                        </button>
                      )}
                      {isOutputVisible && (
                        <button
                          className={`concert-bottom-tab ${activeBottomPanel === "output" ? "active" : ""}`}
                          onClick={() => selectBottomPanel("output")}
                        >
                          Output
                        </button>
                      )}
                    </div>

                    <div className="concert-bottom-panel-content">
                      {activeBottomPanel === "search" && isSearchVisible && (
                        <ConcertSearch
                          nodes={nodes}
                          onClose={toggleSearchPanel}
                          onOpenResult={openSearchResult}
                          showClose={false}
                          showResizer={false}
                          height={searchHeight}
                          onHeightChange={updateSearchHeight}
                          inputTerm={searchInputTerm}
                          submittedTerm={searchSubmittedTerm}
                          onInputTermChange={setSearchInputTerm}
                          onSubmittedTermChange={setSearchSubmittedTerm}
                        />
                      )}

                      {activeBottomPanel === "output" && isOutputVisible && (
                        <ConcertOutputPanel
                          nodes={nodes}
                          run={run}
                          selectedNode={selectedNode}
                          onClose={toggleOutputPanel}
                          onOpenNode={(nodeId, action) => openSearchResult({ nodeId }, action)}
                          showClose={false}
                          showResizer={false}
                          height={searchHeight}
                          onHeightChange={updateSearchHeight}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="empty-tab-panel" />
        )}
      </section>

      <ConcertNodeContextMenu
        menu={contextMenu}
        menuRef={contextMenuRef}
        onViewData={(node) => {
          void viewNodeData(node);
          setContextMenu(null);
        }}
        onBringToFront={(node) => moveTextNodeLayer(node.id, true)}
        onSendToBack={(node) => moveTextNodeLayer(node.id, false)}
        onOpenConcert={(node) => {
          setContextMenu(null);
          void openServerConcert(node.data.concertName, node.data.concertId).catch(showError);
        }}
        canViewLp={Boolean(
          contextMenu?.node?.type === "opl" &&
          (selectedReplayId ||
            (lastRunId && run?.nodes?.[contextMenu.node.id]?.status === "success"))
        )}
        onViewLp={(node) => {
          setContextMenu(null);
          void viewOplLp(node);
        }}
      />

      <EditorPanel
        key={selectedNode?.id || "closed"}
        selectedNode={selectedNode}
        editData={editData}
        setEditData={setEditData}
        searchHighlight={
          selectedNode?.id === searchHighlight?.nodeId ? searchHighlight : null
        }
        inputDataframes={selectedInputDataframes}
        outputColumns={selectedOutputColumns}
        outputMessage={selectedOutputMessage}
        loopIterationMode={selectedLoopIterationMode}
        apiBaseUrl={apiBaseUrl}
        globalVariables={globalVariables}
        inputVariables={inputVariables}
        onSave={saveEditor}
        onClose={closeEditor}
        onRequestClose={requestEditorClose}
      />

      {isSaveChangesDialogOpen && (
        <SaveChangesDialog
          onSave={saveEditor}
          onDiscard={closeEditor}
          onCancel={() => setIsSaveChangesDialogOpen(false)}
        />
      )}

      {pendingCloseTabId && (
        <SaveChangesDialog
          onSave={saveAndClosePendingTab}
          onDiscard={discardAndClosePendingTab}
          onCancel={() => setPendingCloseTabId(null)}
        />
      )}

      {isVariablesDialogOpen && (
        <VariablesDialog
          globalVariables={globalVariables}
          inputVariables={inputVariables}
          onSave={({ globalVariables: nextGlobal, inputVariables: nextInput }) => {
            const changed =
              JSON.stringify(nextGlobal) !== JSON.stringify(globalVariables) ||
              JSON.stringify(nextInput) !== JSON.stringify(inputVariables);
            if (changed) {
              pushHistory("Change variables");
              setIsDirty(true);
              setGlobalVariables(nextGlobal);
              setInputVariables(nextInput);
            }
            setIsVariablesDialogOpen(false);
          }}
          onCancel={() => {
            setIsVariablesDialogOpen(false);
          }}
        />
      )}

      {pendingRun && (
        <RunParamsDialog
          inputVariables={
            pendingRun.replay ? selectedReplay?.inputVariables || [] : inputVariables
          }
          values={
            pendingRun.replay
              ? replayRunParamValues(
                  selectedReplay?.inputVariables || [],
                  selectedReplay?.params || {},
                )
              : runParamValues
          }
          history={replayInputValueHistory(inputVariables, visibleReplays)}
          showInputParameters
          inputParametersDisabled={pendingRun.replay}
          onRun={confirmPendingRun}
          onCancel={() => setPendingRun(null)}
        />
      )}

      {activeRunId && <RunningDialog run={run} onCancel={cancelRun} />}
      {openingConcertName && <RunningDialog title="Opening" message={`${openingConcertName} is opening.`} />}

      {runCompleteTiming && (
        <RunCompleteDialog
          timing={runCompleteTiming}
          onClose={() => setRunCompleteTiming(null)}
        />
      )}

      {isReplayDialogOpen && (
        <ReplayDialog
          replays={visibleReplays}
          selectedReplayId={selectedReplayId}
          servers={servers}
          serverName={replayServerName}
          onServerChange={changeReplayServer}
          onSelect={setSelectedReplayId}
          onClose={() => setIsReplayDialogOpen(false)}
          onOpen={() => setIsReplayDialogOpen(false)}
          onCacheOpen={openReplayCache}
          onClearCache={clearReplayCache}
        />
      )}
      {runCacheSelection && (
        <RunCacheDialog
          replay={runCacheSelection.replay}
          caches={runCacheSelection.caches}
          onClose={() => setRunCacheSelection(null)}
          onOpen={openSelectedRunCache}
          onDelete={deleteSelectedRunCache}
        />
      )}
    </div>
  );
});

export default ConcertTabView;
