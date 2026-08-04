import re

import numpy as np
import pandas as pd

from concert_builder import _compile_python_code, _rewrite_python_variables, _safe_identifier
from oracle_client import describe_oracle_query


def _columns_from_data(data):
    columns = data.get("outputColumns") or []
    return [column for column in columns if isinstance(column, dict) and column.get("name")]


def _dummy_value(type_name, row_index):
    normalized = str(type_name or "").lower()
    if any(token in normalized for token in ("int", "number", "decimal", "float", "double")):
        return row_index + 1
    if any(token in normalized for token in ("date", "time")):
        return pd.Timestamp("2000-01-01") + pd.Timedelta(days=row_index)
    if "bool" in normalized:
        return row_index % 2 == 0
    return f"dummy_{row_index + 1}"


def _dummy_dataframe(columns, row_count=1):
    return pd.DataFrame(
        {
            column["name"]: [
                _dummy_value(column.get("type"), row_index)
                for row_index in range(row_count)
            ]
            for column in columns
        }
    )


def _dataframe_columns(dataframe):
    return [
        {"name": str(column), "type": str(dataframe.dtypes[column])}
        for column in dataframe.columns
    ]


def _sql_with_binds(sql, params):
    names = set(re.findall(r"(?<!:):([A-Za-z_][A-Za-z0-9_]*)", sql or ""))
    return {name: params.get(name) for name in names}


def _infer_python(node, input_columns, params):
    data = node.get("data") or {}
    code = _rewrite_python_variables(data.get("code", ""))
    compiled = _compile_python_code(code)
    func_name = f"func_{_safe_identifier(data.get('name', ''))}"
    scope = {
        "params": params,
        "concert_vars": params,
        "pd": pd,
        "pandas": pd,
        "np": np,
        "numpy": np,
    }
    scope.update(
        {
            key: value
            for key, value in params.items()
            if isinstance(key, str) and key.isidentifier() and key not in scope
        }
    )
    exec(compiled, scope)
    if func_name not in scope:
        raise NameError(f"Python node must define {func_name}(inputs).")
    result = scope[func_name]([_dummy_dataframe(columns) for columns in input_columns])
    if not isinstance(result, pd.DataFrame):
        raise TypeError("Python node dummy result must be a DataFrame.")
    return _dataframe_columns(result)


def infer_concert_columns(nodes, edges, params=None, start_node_id=None):
    params = params or {}
    node_by_id = {node["id"]: node for node in nodes}
    incoming = {node_id: [] for node_id in node_by_id}
    outgoing = {node_id: [] for node_id in node_by_id}
    for edge in edges:
        if edge.get("source") in node_by_id and edge.get("target") in node_by_id:
            incoming[edge["target"]].append(edge)
            outgoing[edge["source"]].append(edge)

    affected = set(node_by_id)
    if start_node_id:
        affected = set()
        queue = [start_node_id]
        while queue:
            node_id = queue.pop(0)
            if node_id in affected:
                continue
            affected.add(node_id)
            queue.extend(edge["target"] for edge in outgoing.get(node_id, []))

    known = {node_id: _columns_from_data(node.get("data") or {}) for node_id, node in node_by_id.items()}
    for edge in edges:
        columns = (edge.get("data") or {}).get("columns") or []
        if columns and not known.get(edge.get("source")):
            known[edge["source"]] = columns

    remaining = set(node_by_id)
    ordered = []
    while remaining:
        ready = [
            node_id
            for node_id in remaining
            if all(edge["source"] not in remaining for edge in incoming[node_id])
        ]
        if not ready:
            ready = [next(iter(remaining))]
        for node_id in ready:
            remaining.remove(node_id)
            ordered.append(node_id)

    errors = {}
    for node_id in ordered:
        if node_id not in affected:
            continue
        node = node_by_id[node_id]
        node_type = node.get("type")
        data = node.get("data") or {}
        parent_columns = [known.get(edge["source"], []) for edge in incoming[node_id]]
        try:
            if node_type == "dbRead":
                sql = re.sub(r"\$([A-Za-z_][A-Za-z0-9_]*)", r":\1", data.get("sql", ""))
                known[node_id] = describe_oracle_query(
                    data.get("connection", ""),
                    sql,
                    params=_sql_with_binds(sql, params),
                )
            elif node_type == "python":
                known[node_id] = _infer_python(node, parent_columns, params)
            elif node_type in {
                "dbWrite",
                "cacheWrite",
                "fileWrite",
                "loopIn",
                "loopOut",
                "concertOutput",
            }:
                known[node_id] = parent_columns[0] if parent_columns else []
            elif node_type in {"concertInput", "cacheRead", "fileRead"}:
                known[node_id] = known.get(node_id, [])
            else:
                known[node_id] = parent_columns[0] if parent_columns else known.get(node_id, [])
        except Exception as exc:
            errors[node_id] = str(exc)
            if parent_columns:
                known[node_id] = parent_columns[0]

    edge_columns = {edge["id"]: known.get(edge["source"], []) for edge in edges}
    return {"nodeColumns": known, "edgeColumns": edge_columns, "errors": errors}
