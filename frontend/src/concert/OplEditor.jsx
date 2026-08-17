import { useEffect, useRef, useState } from "react";

const makeRowId = () => crypto.randomUUID();

const updateRow = (rows, rowId, patch) =>
  rows.map((row) => (row.id === rowId ? { ...row, ...patch } : row));

const pyString = (value) => JSON.stringify(String(value || ""));
const isPythonName = (value) => /^[A-Za-z_]\w*$/.test(String(value || ""));

const splitTopLevelComma = (value) => {
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) {
      return [value.slice(0, index), value.slice(index + 1)];
    }
  }
  return null;
};

const translatePyomoExpression = (
  value,
  componentNames,
  localNames = new Set(),
  sparseNames = new Set(),
  optionalParams = false,
) => {
  let expression = String(value || "").trim();
  const sumReplacements = [];
  let offset = 0;
  while ((offset = expression.indexOf("sum(", offset)) !== -1) {
    let depth = 1;
    let end = offset + 4;
    for (; end < expression.length && depth > 0; end += 1) {
      if (expression[end] === "(") depth += 1;
      else if (expression[end] === ")") depth -= 1;
    }
    if (depth !== 0) break;
    const content = expression.slice(offset + 4, end - 1);
    const parts = splitTopLevelComma(content);
    if (!parts) {
      offset += 4;
      continue;
    }
    const indexText = parts[0].trim();
    if (!indexText.startsWith("[") || !indexText.endsWith("]")) {
      throw new Error("sum indexes must use square brackets: sum([i, j], expression)");
    }
    const indexes = indexText
      .slice(1, -1)
      .split(",")
      .map((name) => name.trim())
      .filter(isPythonName);
    const nestedLocals = new Set([...localNames, ...indexes]);
    const body = translatePyomoExpression(
      parts[1],
      componentNames,
      nestedLocals,
      sparseNames,
      false,
    );
    const generators = indexes.map((name) => `for ${name} in model.${name}`).join(" ");
    const replacement = `pyo.quicksum(_opl_optional_term(lambda: ${body}) ${generators})`;
    const marker = `__PYOMO_SUM_${sumReplacements.length}__`;
    sumReplacements.push(replacement);
    expression = `${expression.slice(0, offset)}${marker}${expression.slice(end)}`;
    offset += marker.length;
  }

  let translated = expression.replace(/[A-Za-z_]\w*/g, (name, tokenOffset, source) => {
    if (localNames.has(name) || !componentNames.has(name)) return name;
    if (tokenOffset > 0 && source[tokenOffset - 1] === ".") return name;
    return `model.${name}`;
  });
  [...sparseNames].sort((left, right) => right.length - left.length).forEach((name) => {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const accessPattern = new RegExp(`model\\.${escapedName}\\s*\\[([^\\]]+)\\]`, "g");
    translated = translated.replace(accessPattern, (_, indexes) => {
      const access = `_opl_component(model.${name}, (${indexes}))`;
      return optionalParams ? `_opl_optional_term(lambda: ${access})` : access;
    });
  });
  sumReplacements.forEach((replacement, index) => {
    translated = translated.replace(`__PYOMO_SUM_${index}__`, replacement);
  });
  return translated;
};

const expressionIndexNames = (value, setNames) => {
  const bound = new Set();
  String(value || "").replace(/sum\s*\(\s*\[([^\]]*)\]/g, (_, names) => {
    names.split(",").map((name) => name.trim()).forEach((name) => bound.add(name));
    return _;
  });
  const result = [];
  String(value || "").replace(/\[([^\]]+)\]/g, (_, names) => {
    names.split(",").map((name) => name.trim()).forEach((name) => {
      if (setNames.has(name) && !bound.has(name) && !result.includes(name)) result.push(name);
    });
    return _;
  });
  return result;
};

const normalizeConditionEquality = (value) =>
  String(value || "").replace(/(^|[^<>=!])=([^=]|$)/g, "$1==$2");

export function buildPyomoCode(data = {}) {
  const sets = data.sets || [];
  const params = data.params || [];
  const variables = data.variables || [];
  const expressions = data.expressions || [];
  const setByName = new Map(sets.map((item) => [item.name, item]));
  const lines = [
    "import pyomo.environ as pyo",
    "",
    "class MissingOplComponentKey(Exception):",
    "    pass",
    "",
    "def _opl_component(component, key):",
    "    if key not in component:",
    "        raise MissingOplComponentKey(f\"{component.name}{key!r}\")",
    "    return component[key]",
    "",
    "def _opl_optional_term(func):",
    "    try:",
    "        return func()",
    "    except MissingOplComponentKey:",
    "        return 0",
    "",
    "model = pyo.ConcreteModel()",
  ];

  if (sets.length) lines.push("", "# Sets");
  sets.forEach((item) => {
    if (!isPythonName(item.name) || !item.inputNodeId || !item.column) {
      lines.push(`# Skipped incomplete set: ${item.name || "<unnamed>"}`);
      return;
    }
    lines.push(
      `model.${item.name} = pyo.Set(initialize=input_dataframes[${pyString(item.inputNodeId)}][${pyString(item.column)}].unique())`,
    );
  });

  if (params.length) lines.push("", "# Parameters");
  params.forEach((item) => {
    if (!isPythonName(item.name) || !item.inputNodeId || !item.column) {
      lines.push(`# Skipped incomplete parameter: ${item.name || "<unnamed>"}`);
      return;
    }
    const indexNames = (item.indexSets || []).filter(isPythonName);
    const indexColumns = indexNames.map((name) => setByName.get(name)?.column).filter(Boolean);
    const dataframe = `input_dataframes[${pyString(item.inputNodeId)}]`;
    if (indexNames.length && indexColumns.length === indexNames.length) {
      const modelIndexes = indexNames.map((name) => `model.${name}`).join(", ");
      lines.push(
        `model.${item.name} = pyo.Param(${modelIndexes}, initialize=${dataframe}.set_index(${JSON.stringify(indexColumns)})[${pyString(item.column)}].to_dict())`,
      );
    } else if (!indexNames.length) {
      lines.push(
        `model.${item.name} = pyo.Param(initialize=${dataframe}[${pyString(item.column)}].iloc[0])`,
      );
    } else {
      lines.push(`# Skipped parameter with incomplete indexes: ${item.name}`);
    }
  });

  const domains = {
    nonNegativeReal: "pyo.NonNegativeReals",
    nonNegativeInteger: "pyo.NonNegativeIntegers",
    binary: "pyo.Binary",
  };
  if (variables.length) lines.push("", "# Variables");
  variables.forEach((item) => {
    if (!isPythonName(item.name)) {
      lines.push(`# Skipped incomplete variable: ${item.name || "<unnamed>"}`);
      return;
    }
    const indexNames = (item.indexSets || []).filter(isPythonName);
    const domain = domains[item.domain] || domains.nonNegativeReal;
    if (!indexNames.length) {
      lines.push(`model.${item.name} = pyo.Var(domain=${domain})`);
      return;
    }
    const indexItems = indexNames.map((name) => setByName.get(name));
    const inputNodeIds = [...new Set(indexItems.map((indexItem) => indexItem?.inputNodeId).filter(Boolean))];
    if (inputNodeIds.length !== 1 || indexItems.some((indexItem) => !indexItem?.column)) {
      lines.push(`# Variable ${item.name} index Sets must use the same input node.`);
      return;
    }
    const dataframe = `input_dataframes[${pyString(inputNodeIds[0])}]`;
    const indexColumns = indexItems.map((indexItem) => indexItem.column);
    const internalSet = `_opl_index_${item.name}`;
    if (indexNames.length === 1) {
      lines.push(`model.${internalSet} = pyo.Set(dimen=1, initialize=${dataframe}[${pyString(indexColumns[0])}].drop_duplicates().tolist())`);
    } else {
      lines.push(`model.${internalSet} = pyo.Set(dimen=${indexNames.length}, initialize=list(${dataframe}[${JSON.stringify(indexColumns)}].drop_duplicates().itertuples(index=False, name=None)))`);
    }
    lines.push(`model.${item.name} = pyo.Var(model.${internalSet}, domain=${domain})`);
  });

  const componentNames = new Set([
    ...sets.map((item) => item.name),
    ...params.map((item) => item.name),
    ...variables.map((item) => item.name),
  ].filter(isPythonName));
  const sparseNames = new Set([
    ...params.map((item) => item.name),
    ...variables.filter((item) => (item.indexSets || []).length).map((item) => item.name),
  ].filter(isPythonName));
  const setNames = new Set(sets.map((item) => item.name).filter(isPythonName));
  const objective = expressions.find((item) => item.kind === "objective");
  if (objective) {
    lines.push("", "# Objective");
    if (!isPythonName(objective.name) || !String(objective.formula || "").trim()) {
      lines.push(`# Skipped incomplete objective: ${objective.name || "<unnamed>"}`);
    } else {
      if (objective.description) lines.push(`# ${objective.description}`);
      const formula = translatePyomoExpression(
        objective.formula,
        componentNames,
        new Set(),
        sparseNames,
        true,
      );
      const sense = (data.objectiveSense || "maximize") === "maximize" ? "pyo.maximize" : "pyo.minimize";
      lines.push(`model.${objective.name} = pyo.Objective(expr=${formula}, sense=${sense})`);
    }
  }

  const constraints = expressions.filter((item) => item.kind === "constraint");
  if (constraints.length) lines.push("", "# Constraints");
  constraints.forEach((item) => {
    if (!isPythonName(item.name) || !String(item.formula || "").trim()) {
      lines.push(`# Skipped incomplete constraint: ${item.name || "<unnamed>"}`);
      return;
    }
    if (item.description) lines.push(`# ${item.description}`);
    const constraintFormula = normalizeConditionEquality(item.formula).trim();
    const condition = normalizeConditionEquality(item.condition).trim();
    const ruleIndexes = expressionIndexNames(constraintFormula, setNames);
    expressionIndexNames(condition, setNames).forEach((name) => {
      if (!ruleIndexes.includes(name)) ruleIndexes.push(name);
    });
    const ruleLocals = new Set(ruleIndexes);
    const formula = translatePyomoExpression(constraintFormula, componentNames, ruleLocals, sparseNames);
    const translatedCondition = translatePyomoExpression(condition, componentNames, ruleLocals, sparseNames);
    const ruleName = `${item.name}_rule`;
    const ruleArgs = ["model", ...ruleIndexes].join(", ");
    lines.push(`def ${ruleName}(${ruleArgs}):`);
    lines.push("    try:");
    if (translatedCondition) {
      lines.push(`        if not (${translatedCondition}):`);
      lines.push("            return pyo.Constraint.Skip");
    }
    lines.push(`        return ${formula}`);
    lines.push("    except MissingOplComponentKey:");
    lines.push("        return pyo.Constraint.Skip");
    const constraintIndexes = ruleIndexes.map((name) => `model.${name}`);
    const constraintArgs = [...constraintIndexes, `rule=${ruleName}`].join(", ");
    lines.push(`model.${item.name} = pyo.Constraint(${constraintArgs})`);
  });

  lines.push("", "# Solve");
  const solverName = data.solver || "highs";
  const timeoutOption = { highs: "time_limit", gurobi: "TimeLimit", cplex: "timelimit" }[solverName];
  const mipGapOption = { highs: "mip_rel_gap", gurobi: "MIPGap", cplex: "mipgap" }[solverName];
  lines.push(`solver = pyo.SolverFactory(${pyString(solverName)})`);
  lines.push(`solver.options[${pyString(timeoutOption)}] = ${Number(data.solverTimeoutSeconds ?? 60)}`);
  lines.push(`solver.options[${pyString(mipGapOption)}] = ${Number(data.mipGap ?? 0.01)}`);
  lines.push("results = solver.solve(model)");

  return lines.join("\n");
}

function GridSection({ title, actionLabel, onAdd, secondaryActionLabel, onSecondaryAdd, secondaryActionDisabled = false, children, className = "", isFullscreen, onToggleFullscreen }) {
  return (
    <section className={`opl-grid-section ${className} ${isFullscreen ? "fullscreen" : ""}`}>
      <div className="opl-grid-header">
        <h3>{title}</h3>
        <div className="opl-grid-header-actions">
          {onSecondaryAdd && (
            <button type="button" disabled={secondaryActionDisabled} onClick={onSecondaryAdd}>
              {secondaryActionLabel}
            </button>
          )}
          {onAdd && (
            <button type="button" onClick={onAdd}>{actionLabel}</button>
          )}
          <button
            type="button"
            className="opl-fullscreen-button"
            onClick={onToggleFullscreen}
            title={isFullscreen ? "Exit full screen" : "Full screen"}
            aria-label={isFullscreen ? `Exit ${title} full screen` : `Open ${title} full screen`}
          >
            {isFullscreen ? "↙" : "↗"}
          </button>
        </div>
      </div>
      <div className="opl-grid-scroll">{children}</div>
    </section>
  );
}

function DeleteButton({ onClick }) {
  return (
    <button
      type="button"
      className="row-delete-button"
      onClick={onClick}
      title="Delete row"
      aria-label="Delete row"
    >
      Delete
    </button>
  );
}

function InputSelect({ value, inputs, onChange }) {
  return (
    <select value={value || ""} onChange={(event) => onChange(event.target.value)}>
      <option value="">Select input</option>
      {inputs.map((input) => (
        <option key={input.id} value={input.id}>
          {input.name}
        </option>
      ))}
    </select>
  );
}

function ColumnInput({ value, inputNodeId, inputs, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const columns =
    inputs.find((input) => input.id === inputNodeId)?.columns || [];
  return (
    <div
      className="opl-column-combobox"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setIsOpen(false);
      }}
    >
      <input
        value={value || ""}
        placeholder="Column name"
        onFocus={() => setIsOpen(true)}
        onChange={(event) => onChange(event.target.value)}
      />
      <button
        type="button"
        className="opl-column-toggle"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setIsOpen((current) => !current)}
        aria-label="Show all columns"
      >▾</button>
      {isOpen && (
        <div className="opl-column-menu">
          {columns.length ? columns.map((column) => (
            <button
              type="button"
              key={column.name}
              title={column.type || "unknown"}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(column.name);
                setIsOpen(false);
              }}
            >
              <span>{column.name}</span>
              <small>{column.type || "unknown"}</small>
            </button>
          )) : (
            <div className="opl-column-empty">No schema columns. Enter a column name directly.</div>
          )}
        </div>
      )}
    </div>
  );
}

function SetChecklist({ value = [], sets, onChange }) {
  const detailsRef = useRef(null);
  const selected = new Set(value);
  const label = value.length ? value.join(", ") : "Select sets";

  useEffect(() => {
    const closeOnOutsidePointer = (event) => {
      const details = detailsRef.current;
      if (details?.open && !details.contains(event.target)) {
        details.open = false;
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);

  return (
    <details ref={detailsRef} className="opl-index-picker">
      <summary title={label}>{label}</summary>
      <div className="opl-index-menu">
        {sets.length ? (
          sets.map((set) => (
            <label key={set.id}>
              <input
                type="checkbox"
                checked={selected.has(set.name)}
                disabled={!set.name}
                onChange={(event) => {
                  const next = new Set(value);
                  if (event.target.checked) next.add(set.name);
                  else next.delete(set.name);
                  onChange(Array.from(next));
                }}
              />
              <span>{set.name || "Unnamed set"}</span>
            </label>
          ))
        ) : (
          <div className="opl-index-empty">Add a set first.</div>
        )}
      </div>
    </details>
  );
}

export default function OplEditor({ editData, setEditData, inputDataframes }) {
  const sets = editData.sets || [];
  const params = editData.params || [];
  const variables = editData.variables || [];
  const expressions = editData.expressions || [];
  const [activeTab, setActiveTab] = useState("model");
  const [fullscreenSection, setFullscreenSection] = useState("");
  const hasObjective = expressions.some((row) => row.kind === "objective");

  const setRows = (key, updater) =>
    setEditData((current) => ({
      ...current,
      [key]: updater(current[key] || []),
    }));

  const removeSet = (row) => {
    setEditData((current) => ({
      ...current,
      sets: (current.sets || []).filter((item) => item.id !== row.id),
      params: (current.params || []).map((item) => ({
        ...item,
        indexSets: (item.indexSets || []).filter((name) => name !== row.name),
      })),
      variables: (current.variables || []).map((item) => ({
        ...item,
        indexSets: (item.indexSets || []).filter((name) => name !== row.name),
      })),
    }));
  };

  const renameSet = (row, name) => {
    setEditData((current) => ({
      ...current,
      sets: updateRow(current.sets || [], row.id, { name }),
      params: (current.params || []).map((item) => ({
        ...item,
        indexSets: (item.indexSets || []).map((value) =>
          value === row.name ? name : value,
        ),
      })),
      variables: (current.variables || []).map((item) => ({
        ...item,
        indexSets: (item.indexSets || []).map((value) =>
          value === row.name ? name : value,
        ),
      })),
    }));
  };

  return (
    <div className="opl-editor">
      <div className="opl-editor-tabs" role="tablist" aria-label="OPL editor tabs">
        <button type="button" className={activeTab === "model" ? "active" : ""} onClick={() => setActiveTab("model")}>Model</button>
        <button type="button" className={activeTab === "options" ? "active" : ""} onClick={() => setActiveTab("options")}>Options</button>
      </div>
      {activeTab === "model" && <div className="opl-quadrant-grid">
        <GridSection
          title="Sets"
          isFullscreen={fullscreenSection === "sets"}
          onToggleFullscreen={() => setFullscreenSection((current) => current === "sets" ? "" : "sets")}
          actionLabel="Add Set"
          onAdd={() =>
            setRows("sets", (rows) => [
              ...rows,
              { id: makeRowId(), name: "", inputNodeId: "", column: "" },
            ])
          }
        >
          <table className="opl-table">
            <thead><tr><th>Name</th><th>Input node</th><th>Column</th><th /></tr></thead>
            <tbody>
              {sets.map((row) => (
                <tr key={row.id}>
                  <td><input value={row.name || ""} onChange={(event) => renameSet(row, event.target.value)} /></td>
                  <td><InputSelect value={row.inputNodeId} inputs={inputDataframes} onChange={(inputNodeId) => setRows("sets", (rows) => updateRow(rows, row.id, { inputNodeId, column: "" }))} /></td>
                  <td><ColumnInput value={row.column} inputNodeId={row.inputNodeId} inputs={inputDataframes} onChange={(column) => setRows("sets", (rows) => updateRow(rows, row.id, { column }))} /></td>
                  <td><DeleteButton onClick={() => removeSet(row)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </GridSection>

        <GridSection
          title="Parameters"
          isFullscreen={fullscreenSection === "params"}
          onToggleFullscreen={() => setFullscreenSection((current) => current === "params" ? "" : "params")}
          actionLabel="Add Param"
          onAdd={() => setRows("params", (rows) => [...rows, { id: makeRowId(), name: "", inputNodeId: "", column: "", indexSets: [] }])}
        >
          <table className="opl-table">
            <thead><tr><th>Name</th><th>Input node</th><th>Column</th><th>Indexes</th><th /></tr></thead>
            <tbody>
              {params.map((row) => (
                <tr key={row.id}>
                  <td><input value={row.name || ""} onChange={(event) => setRows("params", (rows) => updateRow(rows, row.id, { name: event.target.value }))} /></td>
                  <td><InputSelect value={row.inputNodeId} inputs={inputDataframes} onChange={(inputNodeId) => setRows("params", (rows) => updateRow(rows, row.id, { inputNodeId, column: "" }))} /></td>
                  <td><ColumnInput value={row.column} inputNodeId={row.inputNodeId} inputs={inputDataframes} onChange={(column) => setRows("params", (rows) => updateRow(rows, row.id, { column }))} /></td>
                  <td><SetChecklist value={row.indexSets} sets={sets} onChange={(indexSets) => setRows("params", (rows) => updateRow(rows, row.id, { indexSets }))} /></td>
                  <td><DeleteButton onClick={() => setRows("params", (rows) => rows.filter((item) => item.id !== row.id))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </GridSection>

        <GridSection
          title="Variables"
          isFullscreen={fullscreenSection === "variables"}
          onToggleFullscreen={() => setFullscreenSection((current) => current === "variables" ? "" : "variables")}
          actionLabel="Add Variable"
          onAdd={() => setRows("variables", (rows) => [...rows, { id: makeRowId(), name: "", domain: "nonNegativeReal", indexSets: [] }])}
        >
          <table className="opl-table">
            <thead><tr><th>Name</th><th>Type</th><th>Indexes</th><th /></tr></thead>
            <tbody>
              {variables.map((row) => (
                <tr key={row.id}>
                  <td><input value={row.name || ""} onChange={(event) => setRows("variables", (rows) => updateRow(rows, row.id, { name: event.target.value }))} /></td>
                  <td>
                    <select value={row.domain || "nonNegativeReal"} onChange={(event) => setRows("variables", (rows) => updateRow(rows, row.id, { domain: event.target.value }))}>
                      <option value="nonNegativeReal">NonNegative Real</option>
                      <option value="nonNegativeInteger">NonNegative Integer</option>
                      <option value="binary">Binary</option>
                    </select>
                  </td>
                  <td><SetChecklist value={row.indexSets} sets={sets} onChange={(indexSets) => setRows("variables", (rows) => updateRow(rows, row.id, { indexSets }))} /></td>
                  <td><DeleteButton onClick={() => setRows("variables", (rows) => rows.filter((item) => item.id !== row.id))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </GridSection>

        <GridSection
          title="Objective & Constraints"
          className="opl-expression-section"
          isFullscreen={fullscreenSection === "expressions"}
          onToggleFullscreen={() => setFullscreenSection((current) => current === "expressions" ? "" : "expressions")}
          actionLabel="Add Constraint"
          onAdd={() => setRows("expressions", (rows) => [...rows, { id: makeRowId(), kind: "constraint", name: "", formula: "", condition: "", description: "" }])}
          secondaryActionLabel="Add Objective"
          secondaryActionDisabled={hasObjective}
          onSecondaryAdd={() => setRows("expressions", (rows) => [...rows, { id: makeRowId(), kind: "objective", name: "objective", formula: "", condition: "", description: "" }])}
        >
          <table className="opl-table opl-expression-table">
            <thead><tr><th>Type</th><th>Name</th><th>Formula</th><th>Condition</th><th>Description</th><th /></tr></thead>
            <tbody>
              {expressions.map((row) => (
                <tr key={row.id}>
                  <td><span className={`opl-kind opl-kind-${row.kind}`}>{row.kind}</span></td>
                  <td><input value={row.name || ""} onChange={(event) => setRows("expressions", (rows) => updateRow(rows, row.id, { name: event.target.value }))} /></td>
                  <td><input className="opl-formula-input" value={row.formula || ""} onChange={(event) => setRows("expressions", (rows) => updateRow(rows, row.id, { formula: event.target.value }))} /></td>
                  <td>
                    <input
                      value={row.kind === "objective" ? "" : row.condition || ""}
                      disabled={row.kind === "objective"}
                      onChange={(event) => setRows("expressions", (rows) => updateRow(rows, row.id, { condition: event.target.value }))}
                    />
                  </td>
                  <td><input value={row.description || ""} onChange={(event) => setRows("expressions", (rows) => updateRow(rows, row.id, { description: event.target.value }))} /></td>
                  <td><DeleteButton onClick={() => setRows("expressions", (rows) => rows.filter((item) => item.id !== row.id))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </GridSection>
      </div>}
      {activeTab === "options" && (
        <div className="opl-options-panel">
          <fieldset>
            <legend>Objective Sense</legend>
            <label><input type="radio" name="opl-objective-sense" value="maximize" checked={(editData.objectiveSense || "maximize") === "maximize"} onChange={(event) => setEditData((current) => ({ ...current, objectiveSense: event.target.value }))} /> Maximize</label>
            <label><input type="radio" name="opl-objective-sense" value="minimize" checked={editData.objectiveSense === "minimize"} onChange={(event) => setEditData((current) => ({ ...current, objectiveSense: event.target.value }))} /> Minimize</label>
          </fieldset>
          <fieldset>
            <legend>Solver</legend>
            <label><input type="radio" name="opl-solver" value="highs" checked={(editData.solver || "highs") === "highs"} onChange={(event) => setEditData((current) => ({ ...current, solver: event.target.value }))} /> HiGHS</label>
            <label><input type="radio" name="opl-solver" value="gurobi" checked={editData.solver === "gurobi"} onChange={(event) => setEditData((current) => ({ ...current, solver: event.target.value }))} /> Gurobi</label>
            <label><input type="radio" name="opl-solver" value="cplex" checked={editData.solver === "cplex"} onChange={(event) => setEditData((current) => ({ ...current, solver: event.target.value }))} /> CPLEX</label>
          </fieldset>
          <fieldset>
            <legend>Solver Limits</legend>
            <label className="opl-option-number">
              <span>Timeout (seconds)</span>
              <input type="number" min="0.1" step="1" value={editData.solverTimeoutSeconds ?? 60} onChange={(event) => setEditData((current) => ({ ...current, solverTimeoutSeconds: event.target.value }))} />
            </label>
            <label className="opl-option-number">
              <span>MIP Gap</span>
              <input type="number" min="0" max="1" step="0.001" value={editData.mipGap ?? 0.01} onChange={(event) => setEditData((current) => ({ ...current, mipGap: event.target.value }))} />
            </label>
            <span className="opl-option-hint">0.01 means a 1% relative optimality gap.</span>
          </fieldset>
        </div>
      )}
    </div>
  );
}
