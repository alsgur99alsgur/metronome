const NODE_TYPE_LABELS = {
  dbRead: "DB Read", dbWrite: "DB Write", python: "Python", opl: "OPL",
  concert: "Concert Call", concertInput: "Concert Input", concertOutput: "Concert Output",
  cacheRead: "Cache Read", cacheWrite: "Cache Write", loopIn: "Loop In", loopOut: "Loop Out",
};

const blank = (value) => value == null || (typeof value === "string" && !value.trim());
const invalidNumber = (value, minimum = null, maximum = null) => {
  if (blank(value)) return true;
  const number = Number(value);
  return !Number.isFinite(number) || (minimum != null && number < minimum) || (maximum != null && number > maximum);
};

const childrenBySource = (edges) => {
  const children = new Map();
  edges.forEach((edge) => children.set(edge.source, [...(children.get(edge.source) || []), edge.target]));
  return children;
};

const matchingLoopOut = (loopInId, children, types) => {
  const queue = (children.get(loopInId) || []).map((id) => [id, 0]);
  const visited = new Set();
  while (queue.length) {
    const [id, initialDepth] = queue.shift();
    const key = `${id}:${initialDepth}`;
    if (visited.has(key)) continue;
    visited.add(key);
    let depth = initialDepth;
    if (types.get(id) === "loopIn") depth += 1;
    else if (types.get(id) === "loopOut") {
      if (depth === 0) return id;
      depth -= 1;
    }
    (children.get(id) || []).forEach((child) => queue.push([child, depth]));
  }
  return null;
};

const reachableUntil = (children, startId, stopId) => {
  const visited = new Set();
  const stack = [...(children.get(startId) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    if (id !== stopId) stack.push(...(children.get(id) || []));
  }
  return visited;
};

export const runTargetNodes = (nodes, edges, mode, selectedId) => {
  const executable = nodes.filter((node) => node.type !== "text");
  if (mode !== "selected") return executable;
  const byId = new Map(executable.map((node) => [node.id, node]));
  if (!byId.has(selectedId)) throw new Error("Selected node is required for selected mode.");
  const validEdges = edges.filter((edge) => byId.has(edge.source) && byId.has(edge.target));
  const parents = new Map();
  validEdges.forEach((edge) => parents.set(edge.target, [...(parents.get(edge.target) || []), edge.source]));
  const children = childrenBySource(validEdges);
  const types = new Map(executable.map((node) => [node.id, node.type]));
  const included = new Set([selectedId]);
  while (true) {
    const previousSize = included.size;
    const stack = [...included];
    while (stack.length) {
      const id = stack.pop();
      (parents.get(id) || []).forEach((parent) => {
        if (!included.has(parent)) { included.add(parent); stack.push(parent); }
      });
    }
    [...included].forEach((id) => {
      if (types.get(id) !== "loopIn") return;
      const loopOut = matchingLoopOut(id, children, types);
      if (!loopOut) throw new Error(`Loop In has no reachable Loop Out: ${id}`);
      reachableUntil(children, id, loopOut).forEach((nodeId) => included.add(nodeId));
    });
    if (included.size === previousSize) break;
  }
  return executable.filter((node) => included.has(node.id));
};

const oplFields = (data) => {
  const fields = [];
  if (!["highs", "gurobi", "cplex"].includes(data.solver)) fields.push("Solver");
  if (invalidNumber(data.solverTimeoutSeconds, Number.EPSILON)) fields.push("Solver Timeout");
  if (invalidNumber(data.mipGap, 0, 1)) fields.push("MIP Gap");
  const variables = Array.isArray(data.variables) ? data.variables : [];
  const expressions = Array.isArray(data.expressions) ? data.expressions : [];
  if (!variables.length) fields.push("Variable (at least one)");
  if (!expressions.some((item) => ["objective", "constraint"].includes(item?.kind))) fields.push("Objective or Constraint (at least one)");
  (data.sets || []).forEach((item = {}, index) => [["name", "Name"], ["inputNodeId", "Input Node"], ["column", "Column"]].forEach(([key, label]) => { if (blank(item[key])) fields.push(`Set ${index + 1} ${label}`); }));
  (data.params || []).forEach((item = {}, index) => [["name", "Name"], ["inputNodeId", "Input Node"], ["column", "Column"]].forEach(([key, label]) => { if (blank(item[key])) fields.push(`Parameter ${index + 1} ${label}`); }));
  variables.forEach((item = {}, index) => {
    if (blank(item.name)) fields.push(`Variable ${index + 1} Name`);
    if (!["nonNegativeReal", "nonNegativeInteger", "binary"].includes(item.domain)) fields.push(`Variable ${index + 1} Domain`);
  });
  expressions.forEach((item = {}, index) => {
    if (!["objective", "constraint"].includes(item.kind)) fields.push(`Expression ${index + 1} Type`);
    if (blank(item.name)) fields.push(`Expression ${index + 1} Name`);
    if (blank(item.formula)) fields.push(`Expression ${index + 1} Formula`);
    if (item.kind === "constraint" && blank(item.condition)) fields.push(`Expression ${index + 1} Condition`);
  });
  return fields;
};

const loopOutModes = (nodes, edges) => {
  const types = new Map(nodes.map((node) => [node.id, node.type]));
  const children = childrenBySource(edges.filter((edge) => types.has(edge.source) && types.has(edge.target)));
  const result = new Map();
  nodes.filter((node) => node.type === "loopIn").forEach((node) => {
    const loopOut = matchingLoopOut(node.id, children, types);
    if (loopOut) result.set(loopOut, node.data?.iterationMode);
  });
  return result;
};

export const validateRunNodes = (nodes, edges = []) => {
  const modes = loopOutModes(nodes, edges);
  return nodes.flatMap((node) => {
    const data = node.data || {};
    const fields = [];
    if (blank(data.name)) fields.push("Node Name");
    if (["dbRead", "dbWrite"].includes(node.type)) {
      if (blank(data.connection)) fields.push("Connection");
      if (blank(data.sql)) fields.push("SQL");
    } else if (node.type === "python" && blank(data.code)) fields.push("Code");
    else if (node.type === "opl") fields.push(...oplFields(data));
    else if (node.type === "concert" && blank(data.concertName)) fields.push("Concert Name");
    else if (["cacheRead", "cacheWrite"].includes(node.type)) {
      if (!["stage", "concert"].includes(data.scope)) fields.push("Scope");
      if (blank(data.resourceName)) fields.push("Cache Name");
      if (node.type === "cacheWrite") {
        if (!["append", "delete"].includes(data.operation)) fields.push("Operation");
        else if (data.operation === "delete" && blank(data.condition)) fields.push("Condition");
      }
    } else if (node.type === "loopIn") {
      if (!["allRows", "eachRow", "groupBy"].includes(data.iterationMode)) fields.push("Iteration Mode");
      else if (data.iterationMode === "groupBy" && blank(data.groupByColumns)) fields.push("Group By Columns");
    } else if (node.type === "loopOut" && (modes.get(node.id) || "allRows") === "allRows") {
      if (blank(data.maxIterations)) fields.push("Max Iterations");
      (data.stopConditions || []).forEach((condition = {}, index) => {
        if (blank(condition.column)) fields.push(`Stop Condition ${index + 1} Column`);
        if (!["==", "!=", ">=", ">", "<=", "<"].includes(condition.operator)) fields.push(`Stop Condition ${index + 1} Operator`);
        if (blank(condition.value)) fields.push(`Stop Condition ${index + 1} Value`);
      });
    }
    return fields.length ? [{ nodeId: node.id, nodeName: data.name || node.id || "<unknown>", nodeType: node.type, nodeTypeLabel: NODE_TYPE_LABELS[node.type] || node.type, fields }] : [];
  });
};

export const runValidationMessage = (errors) => [
  "Cannot start Concert. Required node settings are missing:",
  ...errors.map((item) => `- ${item.nodeName} (${item.nodeTypeLabel}): ${item.fields.join(", ")}`),
].join("\n");
