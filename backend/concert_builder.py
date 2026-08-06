"""Build current Concert definitions into executable task graphs."""

import io
import json
import re
import tokenize
from datetime import datetime
from functools import lru_cache

import numpy as np
import pandas as pd

from oracle_client import execute_oracle_query_records, execute_oracle_write_records
from task import Task


_CONCERT_VAR_PATTERN = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)")
MAX_CONCERT_CALL_DEPTH = 8
SINGLE_PARENT_TARGET_TYPES = {
    "concert",
    "concertOutput",
    "dbRead",
    "dbWrite",
    "cacheWrite",
    "fileWrite",
    "loopIn",
}
NO_PARENT_TARGET_TYPES = {"concertInput"}
NO_CHILD_SOURCE_TYPES = {"concertOutput"}
REPLAY_TASK_TYPES = {"dbRead", "concertInput", "concert", "cacheRead", "fileRead"}
LOOP_NODE_TYPES = {"loopIn", "loopOut"}


def _safe_identifier(value):
    safe = re.sub(r"\W+", "_", value or "").strip("_")
    if not safe:
        return "task"
    if safe[0].isdigit():
        return f"task_{safe}"
    return safe


@lru_cache(maxsize=4096)
def _rewrite_sql_variables(sql):
    return _CONCERT_VAR_PATTERN.sub(r":\1", sql or "")


@lru_cache(maxsize=4096)
def _rewrite_python_variables(code):
    tokens = list(tokenize.generate_tokens(io.StringIO(code or "").readline))
    rewritten = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if (
            token.string == "$"
            and index + 1 < len(tokens)
            and tokens[index + 1].type == tokenize.NAME
        ):
            rewritten.append((tokenize.NAME, f'concert_vars["{tokens[index + 1].string}"]'))
            index += 2
            continue
        rewritten.append((token.type, token.string))
        index += 1
    return tokenize.untokenize(rewritten)


@lru_cache(maxsize=4096)
def _compile_python_code(code):
    return compile(code, "<concert-python>", "exec")


def _variable_name(item):
    name = str(item.get("name", "") if isinstance(item, dict) else "").strip()
    return name[1:] if name.startswith("$") else name


def _runtime_params(global_variables=None, input_variables=None, params=None):
    result = {}
    for item in global_variables or []:
        if not isinstance(item, dict):
            continue
        name = _variable_name(item)
        if name:
            result[name] = item.get("value")

    for item in input_variables or []:
        if not isinstance(item, dict):
            continue
        name = _variable_name(item)
        if name:
            result[name] = item.get("defaultValue")

    for key, value in (params or {}).items():
        name = str(key)[1:] if str(key).startswith("$") else str(key)
        result[name] = value
    return result


def _parse_mapping(value):
    if isinstance(value, dict):
        return value
    if not value:
        return {}
    if isinstance(value, str):
        return json.loads(value)
    raise TypeError("Concert input parameters must be an object.")


def _resolve_variable_reference(value, params):
    if isinstance(value, str):
        match = _CONCERT_VAR_PATTERN.fullmatch(value.strip())
        if match:
            name = match.group(1)
            if name not in params:
                raise KeyError(f"Variable not found for Concert call parameter: ${name}")
            return params[name]
    if isinstance(value, list):
        return [_resolve_variable_reference(item, params) for item in value]
    if isinstance(value, dict):
        return {
            key: _resolve_variable_reference(item, params)
            for key, item in value.items()
        }
    return value


def _resolve_mapping_variable_references(mapping, params):
    return {
        key: _resolve_variable_reference(value, params)
        for key, value in (mapping or {}).items()
    }


def _json_safe_mapping(value):
    safe = {}
    for key, item in (value or {}).items():
        if str(key).startswith("__"):
            continue
        try:
            json.dumps(item, allow_nan=True)
            safe[key] = item
        except TypeError:
            safe[key] = repr(item)
    return safe


def _params_for_variables(variables, params):
    result = {}
    for item in variables or []:
        if not isinstance(item, dict):
            continue
        name = _variable_name(item)
        if name and name in (params or {}):
            result[name] = params[name]
    return result


def _execute_task_graph(task_map, replay_data_store=None):
    results = {}
    visiting = set()

    def execute_task(task):
        if task.id in results:
            return results[task.id]
        if task.id in visiting:
            raise ValueError(f"Cycle detected at task: {task.name}")

        visiting.add(task.id)
        inputs = [execute_task(parent) for parent in task.parents]
        visiting.remove(task.id)
        results[task.id] = task.execute(inputs)
        if replay_data_store and task.type in REPLAY_TASK_TYPES:
            replay_data_store.save_task_result(task, results[task.id])
        return results[task.id]

    outputs = [task for task in task_map.values() if task.type == "concertOutput"]
    if outputs:
        return execute_task(outputs[0])

    last_result = None
    for task in task_map.values():
        last_result = execute_task(task)
    return last_result


def _bind_records_from_inputs(inputs, params):
    base_params = params or {}
    if not inputs:
        return [base_params]

    input_df = inputs[0]
    if not isinstance(input_df, pd.DataFrame):
        raise TypeError("DB Read node expects the first input to be a pandas DataFrame.")

    records = input_df.where(pd.notnull(input_df), None).to_dict(orient="records")
    if not records:
        return [base_params]

    return [{**base_params, **record} for record in records]


def _build_db_read_task(task_id, name, data, params):
    sql = _rewrite_sql_variables(data.get("sql", ""))
    connection = data.get("connection", "")

    def db_read(inputs):
        print(f"QUERY {name}")
        bind_records = _bind_records_from_inputs(inputs, params)
        result = execute_oracle_query_records(connection, sql, bind_records)
        if result.attrs.get("pm_fallback"):
            print(f"PM SKIP {name}: Oracle connection failed; using cached empty schema.")
        return result

    return Task(task_id, name, "dbRead", db_read)


def _build_python_task(task_id, name, data, params):
    code = _rewrite_python_variables(data.get("code", ""))
    compiled_code = _compile_python_code(code)
    func_name = f"func_{_safe_identifier(name)}"

    def python(inputs):
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
        exec(compiled_code, scope)
        if func_name not in scope:
            raise NameError(f"Python node must define {func_name}(inputs).")
        return scope[func_name](inputs)

    return Task(task_id, name, "python", python)


def _build_db_write_task(task_id, name, data, params):
    sql = _rewrite_sql_variables(data.get("sql", ""))
    connection = data.get("connection", "")

    def db_write(inputs):
        if not inputs:
            bind_records = [params]
            result = pd.DataFrame()
        else:
            result = inputs[0]
            if not isinstance(result, pd.DataFrame):
                raise TypeError("DB Write node expects the first input to be a pandas DataFrame.")
            bind_records = result.where(pd.notnull(result), None).to_dict(orient="records")

        row_count = execute_oracle_write_records(connection, sql, bind_records)
        if row_count is None:
            print(f"PM SKIP {name}: Oracle connection failed; write was not executed.")
        else:
            print(f"WRITE {name}: {row_count} rows affected")
        return result

    return Task(task_id, name, "dbWrite", db_write)


def _build_input_task(task_id, name, data, params):
    input_index = int(data.get("inputIndex", 0) or 0)

    def input_dataframe(_inputs):
        input_dataframes = params.get("__input_dataframes", [])
        if input_index >= len(input_dataframes):
            return pd.DataFrame()
        return input_dataframes[input_index]

    return Task(task_id, name, "concertInput", input_dataframe)


def _build_output_task(task_id, name, data, params):
    def output_dataframe(inputs):
        if not inputs:
            return pd.DataFrame()
        return inputs[0]

    return Task(task_id, name, "concertOutput", output_dataframe)


def _build_resource_read_task(task_id, name, data, resource_store, run_id):
    kind = "cache" if data.get("resourceKind") == "cache" else "file"
    scope = data.get("scope", "")
    resource_name = data.get("resourceName", "")

    def read_resource(_inputs):
        return resource_store.read(kind, scope, resource_name, run_id=run_id)

    return Task(task_id, name, f"{kind}Read", read_resource)


def _build_resource_write_task(task_id, name, data, resource_store, run_id):
    kind = "cache" if data.get("resourceKind") == "cache" else "file"
    scope = data.get("scope", "")
    resource_name = data.get("resourceName", "")
    operation = data.get("operation", "")
    condition = data.get("condition", "")

    def write_resource(inputs):
        if operation == "append":
            if len(inputs) != 1:
                raise ValueError(f"{kind.title()} append requires exactly one input DataFrame.")
            input_dataframe = inputs[0]
            resource_store.append(
                kind,
                scope,
                resource_name,
                input_dataframe,
                run_id=run_id,
            )
            return input_dataframe
        if operation == "delete":
            if len(inputs) > 1:
                raise ValueError(f"{kind.title()} delete accepts at most one input DataFrame.")
            resource_store.delete_rows(
                kind,
                scope,
                resource_name,
                condition,
                run_id=run_id,
            )
            return inputs[0] if inputs else pd.DataFrame()
        raise ValueError(f"Invalid {kind} write operation: {operation}")

    return Task(task_id, name, f"{kind}Write", write_resource)


def _build_loop_in_task(task_id, name, data, params):
    def loop_in(inputs):
        if inputs:
            return inputs[0]
        return pd.DataFrame()

    task = Task(task_id, name, "loopIn", loop_in)
    task.loop_data = data or {}
    task.loop_params = params
    return task


def _build_loop_out_task(task_id, name, data, params):
    def loop_out(inputs):
        if not inputs:
            return pd.DataFrame()
        return inputs[0]

    task = Task(task_id, name, "loopOut", loop_out)
    task.loop_data = data or {}
    task.loop_params = params
    return task


def _build_concert_call_task(
    task_id,
    name,
    data,
    params,
    concert_root,
    replay_root,
    call_stack,
    call_ids,
    caller_input_params,
    resource_store,
    run_id,
):
    concert_id = data.get("concertId", "")
    concert_name = data.get("concertName", "")
    input_params = _parse_mapping(data.get("inputParams", {}))

    def concert_call(inputs):
        if not concert_id:
            raise ValueError("Concert call node has no Concert selected.")
        if concert_id in call_ids:
            raise RecursionError(
                f"Concert self-call is not allowed: {' -> '.join(call_stack + [concert_name])}"
            )
        if len(call_stack) >= MAX_CONCERT_CALL_DEPTH:
            raise RecursionError(
                f"Concert call depth exceeded: {' -> '.join(call_stack + [concert_name])}"
            )

        from concert_store import ConcertStore
        from replay_data_store import ReplayDataStore

        concert_store = ConcertStore(concert_root)
        concert = concert_store.load_by_id(concert_id)
        resolved_concert_name = concert["name"]
        resolved_input_params = _resolve_mapping_variable_references(input_params, params)
        called_input_variables = concert["inputVariables"]
        sub_params = _runtime_params(
            concert["globalVariables"],
            called_input_variables,
            {**params, **resolved_input_params, "__input_dataframes": inputs},
        )
        called_params = _params_for_variables(called_input_variables, sub_params)
        sub_replay_data_store = ReplayDataStore(replay_root, concert_name=resolved_concert_name)
        sub_replay_data_store.save_metadata(
            {
                "id": sub_replay_data_store.replay_id,
                "concertName": resolved_concert_name,
                "createdAt": datetime.utcnow().isoformat() + "Z",
                "trigger": "concert-call",
                "sourceKind": "concert-call",
                "sourceLabel": "Concert Call",
                "sourceDetail": f"Called by {call_stack[-1] if call_stack else 'unknown'} / {name}",
                "callerName": call_stack[-1] if call_stack else "",
                "executedBy": {
                    "type": "concert-call",
                    "callerConcert": call_stack[-1] if call_stack else None,
                    "callNode": name,
                    "callStack": call_stack,
                },
                "params": _json_safe_mapping(called_params),
                "calledParams": _json_safe_mapping(called_params),
                "callerParams": _json_safe_mapping(caller_input_params),
                "globalVariables": concert["globalVariables"],
                "inputVariables": called_input_variables,
            }
        )
        sub_task_map = build_concert(
            concert["nodes"],
            concert["edges"],
            params=sub_params,
            concert_root=concert_root,
            replay_root=replay_root,
            call_stack=call_stack + [resolved_concert_name],
            call_ids=call_ids + [concert_id],
            caller_input_params=called_params,
            resource_store=resource_store,
            run_id=run_id,
        )
        return _execute_task_graph(sub_task_map, replay_data_store=sub_replay_data_store)

    return Task(task_id, name, "concert", concert_call)


def _children_by_source(edges):
    children = {}
    for edge in edges:
        children.setdefault(edge["source"], []).append(edge["target"])
    return children


def _reachable_until(children_by_source, start_id, stop_id):
    visited = set()
    stack = list(children_by_source.get(start_id, []))
    while stack:
        node_id = stack.pop()
        if node_id in visited:
            continue
        visited.add(node_id)
        if node_id == stop_id:
            continue
        stack.extend(children_by_source.get(node_id, []))
    return visited


def _matching_loop_out(loop_in_id, children_by_source, node_type_by_id):
    queue = [(child_id, 0) for child_id in children_by_source.get(loop_in_id, [])]
    visited = set()
    while queue:
        node_id, depth = queue.pop(0)
        state = (node_id, depth)
        if state in visited:
            continue
        visited.add(state)
        node_type = node_type_by_id.get(node_id)
        if node_type == "loopIn":
            depth += 1
        elif node_type == "loopOut":
            if depth == 0:
                return node_id
            depth -= 1
        for child_id in children_by_source.get(node_id, []):
            queue.append((child_id, depth))
    return None


def _loop_blocks(nodes, edges, node_type_by_id):
    children_by_source = _children_by_source(edges)
    blocks = {}
    for node in nodes:
        loop_in_id = node["id"]
        if node_type_by_id.get(loop_in_id) != "loopIn":
            continue
        loop_out_id = _matching_loop_out(loop_in_id, children_by_source, node_type_by_id)
        if not loop_out_id:
            raise ValueError(f"Loop In has no reachable Loop Out: {loop_in_id}")
        body = _reachable_until(children_by_source, loop_in_id, loop_out_id)
        if loop_out_id not in body:
            raise ValueError(f"Loop Out is not reachable from Loop In: {loop_in_id}")
        blocks[loop_in_id] = {
            "loop_in_id": loop_in_id,
            "loop_out_id": loop_out_id,
            "body": body,
            "size": len(body),
        }
    return blocks


def _loop_owner_by_node(blocks):
    owner_by_node = {}
    for loop_in_id, block in sorted(blocks.items(), key=lambda item: item[1]["size"]):
        for node_id in block["body"]:
            owner_by_node.setdefault(node_id, loop_in_id)
    return owner_by_node


def _loop_for_out_id(blocks, loop_out_id):
    for loop_in_id, block in blocks.items():
        if block["loop_out_id"] == loop_out_id:
            return loop_in_id
    return None


def _link_tasks(parent, child):
    if child in parent.children:
        return
    parent >> child


def build_concert(
    nodes,
    edges,
    params=None,
    concert_root="./concerts",
    replay_root="./replay",
    call_stack=None,
    call_ids=None,
    caller_input_params=None,
    resource_store=None,
    run_id=None,
):
    params = params or {}
    caller_input_params = caller_input_params or {}
    call_stack = call_stack or []
    call_ids = call_ids or []
    task_map = {}
    node_type_by_id = {}
    node_by_id = {node["id"]: node for node in nodes}

    for node in nodes:
        node_type = node["type"]
        data = node["data"]
        task_id = node["id"]
        node_type_by_id[task_id] = node_type
        name = data["name"]
        if node_type == "dbRead":
            task_map[task_id] = _build_db_read_task(task_id, name, data, params)
        elif node_type == "python":
            task_map[task_id] = _build_python_task(task_id, name, data, params)
        elif node_type == "dbWrite":
            task_map[task_id] = _build_db_write_task(task_id, name, data, params)
        elif node_type == "concertInput":
            task_map[task_id] = _build_input_task(task_id, name, data, params)
        elif node_type == "concertOutput":
            task_map[task_id] = _build_output_task(task_id, name, data, params)
        elif node_type == "loopIn":
            task_map[task_id] = _build_loop_in_task(task_id, name, data, params)
        elif node_type == "loopOut":
            task_map[task_id] = _build_loop_out_task(task_id, name, data, params)
        elif node_type in {"cacheRead", "fileRead"}:
            if resource_store is None:
                raise RuntimeError("Resource store is not configured.")
            task_map[task_id] = _build_resource_read_task(
                task_id, name, data, resource_store, run_id
            )
        elif node_type in {"cacheWrite", "fileWrite"}:
            if resource_store is None:
                raise RuntimeError("Resource store is not configured.")
            task_map[task_id] = _build_resource_write_task(
                task_id, name, data, resource_store, run_id
            )
        elif node_type == "concert":
            task_map[task_id] = _build_concert_call_task(
                task_id,
                name,
                data,
                params,
                concert_root,
                replay_root,
                call_stack,
                call_ids,
                caller_input_params,
                resource_store,
                run_id,
            )
        else:
            raise ValueError(f"Unsupported node type: {node_type}")

    loop_blocks = _loop_blocks(nodes, edges, node_type_by_id)
    loop_owner_by_node = _loop_owner_by_node(loop_blocks)

    for loop_in_id, block in loop_blocks.items():
        loop_task = task_map[loop_in_id]
        loop_out_task = task_map[block["loop_out_id"]]
        loop_task.loop_out_task = loop_out_task
        loop_task.loop_data = node_by_id[loop_in_id].get("data", {})
        direct_body_ids = {
            node_id
            for node_id in block["body"]
            if loop_owner_by_node.get(node_id) == loop_in_id
        }
        loop_task.loop_body_tasks = [task_map[node_id] for node_id in direct_body_ids]
        for node_id in direct_body_ids:
            task_map[node_id].internal_loop_task = True
            task_map[node_id].loop_owner_id = loop_in_id

    edges_to_link = []
    seen_single_parent_targets = set()
    for edge in reversed(edges):
        source_id = edge["source"]
        target_id = edge["target"]
        if node_type_by_id.get(source_id) in NO_CHILD_SOURCE_TYPES:
            continue
        if node_type_by_id.get(target_id) in NO_PARENT_TARGET_TYPES:
            continue
        if node_type_by_id.get(target_id) in SINGLE_PARENT_TARGET_TYPES:
            if target_id in seen_single_parent_targets:
                continue
            seen_single_parent_targets.add(target_id)
        edges_to_link.append(edge)

    for edge in reversed(edges_to_link):
        source_id = edge["source"]
        target_id = edge["target"]
        source_loop = _loop_for_out_id(loop_blocks, source_id)
        if source_loop and loop_owner_by_node.get(target_id) != source_loop:
            source_id = source_loop

        source_owner = loop_owner_by_node.get(source_id)
        target_owner = loop_owner_by_node.get(target_id)
        if source_owner != target_owner:
            if node_type_by_id.get(source_id) == "loopIn" and target_owner == source_id:
                pass
            elif source_loop and target_owner == source_loop:
                source_id = source_loop
            else:
                if target_owner:
                    loop_task = task_map[target_owner]
                    if source_id != target_owner:
                        _link_tasks(task_map[source_id], loop_task)
                        loop_task.loop_dependency_parent_ids.add(source_id)

        if node_type_by_id.get(source_id) == "loopOut":
            continue

        parent = task_map[source_id]
        child = task_map[target_id]
        _link_tasks(parent, child)

    for loop_in_id, block in loop_blocks.items():
        loop_task = task_map[loop_in_id]
        direct_body_ids = {task.id for task in loop_task.loop_body_tasks}
        loop_task.loop_body_roots = [
            task
            for task in loop_task.loop_body_tasks
            if task.id != block["loop_out_id"]
            and not any(parent.id in direct_body_ids for parent in task.parents)
        ]

    return task_map


def collect_dependencies(task, visited=None):
    if visited is None:
        visited = set()
    if task.id in visited:
        return []

    visited.add(task.id)
    result = []
    for parent in task.parents:
        result.extend(collect_dependencies(parent, visited))
    result.append(task)
    return result
