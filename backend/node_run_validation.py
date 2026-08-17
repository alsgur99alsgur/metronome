"""Required-field validation for manually submitted Concert run nodes."""


NODE_TYPE_LABELS = {
    "dbRead": "DB Read",
    "dbWrite": "DB Write",
    "python": "Python",
    "opl": "OPL",
    "concert": "Concert Call",
    "concertInput": "Concert Input",
    "concertOutput": "Concert Output",
    "cacheRead": "Cache Read",
    "cacheWrite": "Cache Write",
    "loopIn": "Loop In",
    "loopOut": "Loop Out",
}


def _blank(value):
    return value is None or (isinstance(value, str) and not value.strip())


def _invalid_number(value, *, minimum=None, maximum=None):
    if _blank(value):
        return True
    try:
        number = float(value)
    except (TypeError, ValueError):
        return True
    return (minimum is not None and number < minimum) or (
        maximum is not None and number > maximum
    )


def _missing_opl_fields(data):
    missing = []
    if data.get("solver") not in {"highs", "gurobi", "cplex"}:
        missing.append("Solver")
    if _invalid_number(data.get("solverTimeoutSeconds"), minimum=0.0000001):
        missing.append("Solver Timeout")
    if _invalid_number(data.get("mipGap"), minimum=0, maximum=1):
        missing.append("MIP Gap")

    variables = data.get("variables")
    expressions = data.get("expressions")
    if not isinstance(variables, list) or not variables:
        missing.append("Variable (at least one)")
        variables = []
    if not isinstance(expressions, list) or not any(
        isinstance(item, dict) and item.get("kind") in {"objective", "constraint"}
        for item in expressions or []
    ):
        missing.append("Objective or Constraint (at least one)")
        expressions = [] if not isinstance(expressions, list) else expressions

    for index, item in enumerate(data.get("sets") or [], 1):
        item = item if isinstance(item, dict) else {}
        for key, label in (("name", "Name"), ("inputNodeId", "Input Node"), ("column", "Column")):
            if _blank(item.get(key)):
                missing.append(f"Set {index} {label}")
    for index, item in enumerate(data.get("params") or [], 1):
        item = item if isinstance(item, dict) else {}
        for key, label in (("name", "Name"), ("inputNodeId", "Input Node"), ("column", "Column")):
            if _blank(item.get(key)):
                missing.append(f"Parameter {index} {label}")
    for index, item in enumerate(variables, 1):
        item = item if isinstance(item, dict) else {}
        if _blank(item.get("name")):
            missing.append(f"Variable {index} Name")
        if item.get("domain") not in {"nonNegativeReal", "nonNegativeInteger", "binary"}:
            missing.append(f"Variable {index} Domain")
    for index, item in enumerate(expressions, 1):
        item = item if isinstance(item, dict) else {}
        kind = item.get("kind")
        if kind not in {"objective", "constraint"}:
            missing.append(f"Expression {index} Type")
        if _blank(item.get("name")):
            missing.append(f"Expression {index} Name")
        if _blank(item.get("formula")):
            missing.append(f"Expression {index} Formula")
    return missing


def _loop_out_modes(nodes, edges):
    node_types = {node.get("id"): node.get("type") for node in nodes}
    children = {}
    for edge in edges or []:
        if edge.get("source") in node_types and edge.get("target") in node_types:
            children.setdefault(edge["source"], []).append(edge["target"])
    result = {}
    for node in nodes:
        if node.get("type") != "loopIn":
            continue
        queue = [(child, 0) for child in children.get(node.get("id"), [])]
        visited = set()
        while queue:
            node_id, depth = queue.pop(0)
            state = (node_id, depth)
            if state in visited:
                continue
            visited.add(state)
            if node_types.get(node_id) == "loopIn":
                depth += 1
            elif node_types.get(node_id) == "loopOut":
                if depth == 0:
                    result[node_id] = (node.get("data") or {}).get("iterationMode")
                    break
                depth -= 1
            queue.extend((child, depth) for child in children.get(node_id, []))
    return result


def validate_run_nodes(nodes, edges=None):
    errors = []
    loop_out_modes = _loop_out_modes(nodes, edges)
    for node in nodes:
        if node.get("type") == "text":
            continue
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        node_type = node.get("type", "")
        missing = []
        if _blank(data.get("name")):
            missing.append("Node Name")
        if node_type in {"dbRead", "dbWrite"}:
            if _blank(data.get("connection")):
                missing.append("Connection")
            if _blank(data.get("sql")):
                missing.append("SQL")
        elif node_type == "python":
            if _blank(data.get("code")):
                missing.append("Code")
        elif node_type == "opl":
            missing.extend(_missing_opl_fields(data))
        elif node_type == "concert":
            if _blank(data.get("concertName")):
                missing.append("Concert Name")
        elif node_type in {"cacheRead", "cacheWrite"}:
            if data.get("scope") not in {"stage", "concert"}:
                missing.append("Scope")
            if _blank(data.get("resourceName")):
                missing.append("Cache Name")
            if node_type == "cacheWrite":
                operation = data.get("operation")
                if operation not in {"append", "delete"}:
                    missing.append("Operation")
                elif operation == "delete" and _blank(data.get("condition")):
                    missing.append("Condition")
        elif node_type == "loopIn":
            mode = data.get("iterationMode")
            if mode not in {"allRows", "eachRow", "groupBy"}:
                missing.append("Iteration Mode")
            elif mode == "groupBy" and _blank(data.get("groupByColumns")):
                missing.append("Group By Columns")
        elif node_type == "loopOut":
            if loop_out_modes.get(node.get("id"), "allRows") == "allRows":
                if _blank(data.get("maxIterations")):
                    missing.append("Max Iterations")
                conditions = data.get("stopConditions") or []
                for index, condition in enumerate(conditions, 1):
                    condition = condition if isinstance(condition, dict) else {}
                    if _blank(condition.get("column")):
                        missing.append(f"Stop Condition {index} Column")
                    if condition.get("operator") not in {"==", "!=", ">=", ">", "<=", "<"}:
                        missing.append(f"Stop Condition {index} Operator")
                    if _blank(condition.get("value")):
                        missing.append(f"Stop Condition {index} Value")
        if missing:
            errors.append({
                "nodeId": node.get("id"),
                "nodeName": str(data.get("name") or node.get("id") or "<unknown>"),
                "nodeType": node_type,
                "nodeTypeLabel": NODE_TYPE_LABELS.get(node_type, node_type or "Unknown"),
                "fields": missing,
            })
    return errors


def validation_message(errors):
    lines = ["Cannot start Concert. Required node settings are missing:"]
    lines.extend(
        f"- {item['nodeName']} ({item['nodeTypeLabel']}): {', '.join(item['fields'])}"
        for item in errors
    )
    return "\n".join(lines)
