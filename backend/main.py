from datetime import datetime
import json
import os
import re
import socket
import time
from threading import Lock, Thread
from typing import Any, Optional
from uuid import uuid4

import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from cache_data_store import CacheDataStore
from concert_store import ConcertStore
from deployment_store import DeploymentStore, VersionMismatchError
from concert_builder import build_concert, collect_dependencies
from executor import Executor
from oracle_client import OracleUnavailable, describe_oracle_query, list_connection_names
from replay_data_store import ReplayDataStore
from resource_store import ResourceStore
from server_manager import ServerManager
from schema_inference import infer_concert_columns


BACKEND_ROOT = os.path.dirname(os.path.abspath(__file__))
REPLAY_ROOT = os.path.join(BACKEND_ROOT, "replay")
CONCERT_ROOT = os.path.join(BACKEND_ROOT, "concerts")
STAGE_ROOT = os.path.join(BACKEND_ROOT, "stage")
TMP_ROOT = os.path.join(BACKEND_ROOT, "tmp")
SERVERS_PATH = os.path.join(BACKEND_ROOT, "servers.json")
EXECUTOR_ID = socket.gethostname()


class AllowNaNJSONResponse(JSONResponse):
    def render(self, content: Any) -> bytes:
        return json.dumps(
            content,
            ensure_ascii=False,
            allow_nan=True,
            separators=(",", ":"),
        ).encode("utf-8")


class ConcertSaveRequest(BaseModel):
    concertId: str
    version: str
    name: str
    nodes: list
    edges: list
    globalVariables: list = Field(default_factory=list)
    inputVariables: list = Field(default_factory=list)


class RunRequest(BaseModel):
    concertId: str
    concertName: str
    nodes: list
    edges: list
    globalVariables: list = Field(default_factory=list)
    inputVariables: list = Field(default_factory=list)
    mode: str = "all"
    selected: Optional[str] = None
    replay: bool = False
    replayId: Optional[str] = None
    params: dict[str, Any] = Field(default_factory=dict)


class TriggerRunRequest(BaseModel):
    concertName: str
    params: dict[str, Any] = Field(default_factory=dict)
    mode: str = "all"
    selected: Optional[str] = None


class DbReadDescribeRequest(BaseModel):
    connection: Optional[str] = None
    sql: str = ""
    params: dict[str, Any] = Field(default_factory=dict)


class SchemaInferRequest(BaseModel):
    nodes: list
    edges: list
    globalVariables: list = Field(default_factory=list)
    inputVariables: list = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)
    startNodeId: Optional[str] = None


class StageResourceRequest(BaseModel):
    kind: str
    name: str


class DeploymentRequest(BaseModel):
    concertId: str
    sourceName: str
    deploymentPath: str
    allowVersionMismatch: bool = False
    version: str
    name: str
    nodes: list
    edges: list
    globalVariables: list = Field(default_factory=list)
    inputVariables: list = Field(default_factory=list)


class DeploymentNameRequest(BaseModel):
    name: str


class RollbackRequest(BaseModel):
    backupPath: str


class DeploymentDirectoryRequest(BaseModel):
    directory: str


class DeploymentMoveRequest(BaseModel):
    name: str
    directory: str


class DeploymentDeleteRequest(BaseModel):
    kind: str
    path: str


def _dataframe_payload(dataframe, limit=1000):
    snapshot = dataframe.head(limit).copy()
    snapshot.columns = [str(column) for column in snapshot.columns]
    snapshot = snapshot.astype(object).where(pd.notnull(snapshot), None)
    snapshot = snapshot.replace({float("inf"): None, float("-inf"): None})
    return {
        "kind": "dataframe",
        "rows": int(len(dataframe)),
        "columns": list(snapshot.columns),
        "dtypes": {
            str(column): str(dtype)
            for column, dtype in zip(dataframe.columns, dataframe.dtypes)
        },
        "data": snapshot.to_dict(orient="records"),
        "dataLimit": limit,
        "truncated": len(dataframe) > limit,
    }


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


def _params_for_variables(variables=None, params=None):
    result = {}
    for item in variables or []:
        if not isinstance(item, dict):
            continue
        name = _variable_name(item)
        if name and name in (params or {}):
            result[name] = params[name]
    return result


def _run_source_metadata(trigger, request=None):
    client_host = request.client.host if request and request.client else None
    if trigger == "manual":
        return {
            "sourceKind": "user",
            "sourceLabel": "User",
            "sourceDetail": f"User run from {client_host}" if client_host else "User run",
            "callerName": client_host or "",
            "clientIp": client_host,
            "executedBy": {"type": "manual", "sourceKind": "user", "clientIp": client_host},
        }
    if trigger == "scheduler":
        return {
            "sourceKind": "scheduler",
            "sourceLabel": "Scheduler",
            "sourceDetail": "Scheduled run",
            "callerName": "scheduler",
            "executedBy": {"type": "scheduler"},
        }
    if trigger == "event":
        return {
            "sourceKind": "event",
            "sourceLabel": "Event",
            "sourceDetail": "Event-triggered run",
            "callerName": "event",
            "executedBy": {"type": "event"},
        }
    return {
        "sourceKind": trigger,
        "sourceLabel": trigger,
        "sourceDetail": trigger,
        "callerName": trigger,
        "executedBy": {"type": trigger},
    }


def _rewrite_sql_variables(sql):
    return re.sub(r"\$([A-Za-z_][A-Za-z0-9_]*)", r":\1", sql or "")


def _sql_bind_defaults(sql, params):
    bind_names = re.findall(r"(?<!:):([A-Za-z_][A-Za-z0-9_]*)", sql or "")
    return {name: (params or {}).get(name) for name in bind_names}


app = FastAPI(default_response_class=AllowNaNJSONResponse)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

runs = {}
runs_lock = Lock()
executors = {}
concert_store = ConcertStore(CONCERT_ROOT)
deployment_store = DeploymentStore(BACKEND_ROOT)
resource_store = ResourceStore(STAGE_ROOT, TMP_ROOT)
server_manager = ServerManager(SERVERS_PATH)


def _run_timestamp():
    return datetime.now().strftime("%Y%m%d_%H%M%S_%f")


def _now():
    return datetime.utcnow().isoformat() + "Z"


def _initial_node_states(task_map):
    return {
        task.id: {
            "id": task.id,
            "name": task.name,
            "type": task.type,
            "status": "pending",
            "logs": "",
            "error": None,
            "result": None,
            "durationMs": None,
            "cacheDurationMs": None,
            "loopIterations": None,
            "updatedAt": _now(),
        }
        for task in task_map.values()
    }


def _run_response(run_state, include_data=False):
    def node_without_result(node):
        next_node = {
            key: value
            for key, value in node.items()
            if key != "result"
        }
        result = node.get("result")
        if isinstance(result, dict) and result.get("kind") == "dataframe":
            next_node["rows"] = result.get("rows")
        return next_node

    response = {
        **run_state,
        "nodes": {
            node_id: (
                {**node}
                if include_data
                else node_without_result(node)
            )
            for node_id, node in run_state.get("nodes", {}).items()
        },
    }
    return response


def _finish_cache(replay_root, cache_id, status, finished_at=None, timing=None):
    found = CacheDataStore.find_cache(replay_root, cache_id)
    if not found:
        return
    _, _, cache_path, metadata = found
    metadata["status"] = status
    metadata["finishedAt"] = finished_at or _now()
    metadata["updatedAt"] = _now()
    if timing is not None:
        metadata["timing"] = timing
    with open(os.path.join(cache_path, "metadata.json"), "w", encoding="utf-8") as file:
        json.dump(metadata, file, ensure_ascii=False, allow_nan=True, indent=2)


def _run_in_background(
    run_started_at,
    run_id,
    concert_name,
    task_map,
    roots,
    replay,
    replay_id,
    run_timestamp,
    run_task_ids,
    replay_metadata,
    cache_metadata,
):
    def on_event(
        task,
        status,
        logs="",
        error=None,
        result=None,
        duration_ms=None,
        cache_duration_ms=None,
        replay_save_duration_ms=None,
    ):
        with runs_lock:
            run_state = runs[run_id]
            if run_state.get("status") == "canceled" and status != "skipped":
                return
            node = run_state["nodes"][task.id]
            node["status"] = status
            node["logs"] = logs or node["logs"]
            node["error"] = error
            node["updatedAt"] = _now()
            if result is not None:
                node["result"] = result
            if task.loop_iterations is not None:
                node["loopIterations"] = task.loop_iterations
            if duration_ms is not None:
                previous_duration_ms = node.get("durationMs") or 0
                node["durationMs"] = duration_ms
                run_state["timing"]["executionMs"] += duration_ms - previous_duration_ms
            if replay_save_duration_ms is not None:
                run_state["timing"]["replaySaveMs"] += replay_save_duration_ms
            if cache_duration_ms is not None:
                node["cacheDurationMs"] = (node.get("cacheDurationMs") or 0) + cache_duration_ms
                run_state["timing"]["cacheSaveMs"] += cache_duration_ms
            run_state["timing"]["executionReplayMs"] = (
                run_state["timing"]["executionMs"] + run_state["timing"]["replaySaveMs"]
            )
            run_state["timing"]["executionReplayCacheMs"] = (
                run_state["timing"]["executionReplayMs"] + run_state["timing"]["cacheSaveMs"]
            )

            statuses = [item["status"] for item in run_state["nodes"].values()]
            if "error" in statuses:
                run_state["status"] = "error"
            elif run_state.get("status") == "canceled":
                pass
            elif any(item == "running" for item in statuses):
                run_state["status"] = "running"
            elif all(item in ("success", "skipped") for item in statuses):
                run_state["status"] = "success"
            run_state["updatedAt"] = _now()

    with runs_lock:
        runs[run_id]["status"] = "running"
        runs[run_id]["updatedAt"] = _now()

    cache_data_store = None

    def finish_cache(status, finished_at=None, timing=None):
        if cache_data_store is not None:
            cache_data_store.finish(status, finished_at=finished_at, timing=timing)
            return
        _finish_cache(
            REPLAY_ROOT,
            cache_metadata["id"],
            status,
            finished_at=finished_at,
            timing=timing,
        )

    try:
        replay_data_store = ReplayDataStore(
            REPLAY_ROOT,
            concert_name=concert_name,
            replay_id=replay_id if replay else None,
            run_timestamp=run_timestamp,
        )
        replay_data_store.save_metadata(replay_metadata)
        cache_data_store = CacheDataStore(
            REPLAY_ROOT,
            concert_name=concert_name,
            source_replay_id=cache_metadata["sourceReplayId"],
            metadata=cache_metadata,
        )
        executor = Executor(
            replay_data_store,
            cache_data_store=cache_data_store,
            replay=replay,
            on_event=on_event,
            runnable_task_ids=run_task_ids,
        )
        with runs_lock:
            executors[run_id] = executor
        executor.start()
        for root in roots:
            executor.submit(root)
        executor.wait()
    except Exception as exc:
        with runs_lock:
            run_state = runs[run_id]
            run_state["status"] = "error"
            run_state["updatedAt"] = _now()
            run_state["finishedAt"] = _now()
            run_state["timing"]["totalElapsedMs"] = int((time.time() - run_started_at) * 1000)
            for node_id, node in run_state["nodes"].items():
                if node_id in run_task_ids and node["status"] == "pending":
                    node["status"] = "skipped"
                    node["error"] = str(exc)
                    node["updatedAt"] = _now()
        with runs_lock:
            timing = runs.get(run_id, {}).get("timing")
        finish_cache("error", timing=timing)
        return
    finally:
        with runs_lock:
            executors.pop(run_id, None)
        resource_store.cleanup_run(run_id)

    finish_status = None
    finish_finished_at = None
    finish_timing = None
    with runs_lock:
        run_state = runs[run_id]
        if run_state["status"] == "canceled":
            run_state["updatedAt"] = _now()
            run_state["finishedAt"] = _now()
            run_state["timing"]["totalElapsedMs"] = int((time.time() - run_started_at) * 1000)
            finish_status = "canceled"
            finish_finished_at = run_state["finishedAt"]
            finish_timing = run_state.get("timing")
        else:
            pending_nodes = [
                node
                for node_id, node in run_state["nodes"].items()
                if node_id in run_task_ids and node["status"] == "pending"
            ]
            if pending_nodes:
                run_state["status"] = "error"
                for node in pending_nodes:
                    node["status"] = "skipped"
                    node["error"] = "Run finished before this node became executable."
                    node["updatedAt"] = _now()
            elif run_state["status"] == "running":
                run_state["status"] = "success"
            run_state["updatedAt"] = _now()
            run_state["finishedAt"] = _now()
            run_state["timing"]["totalElapsedMs"] = int((time.time() - run_started_at) * 1000)
            finish_status = run_state["status"]
            finish_finished_at = run_state["finishedAt"]
            finish_timing = run_state.get("timing")

    finish_cache(finish_status, finish_finished_at, finish_timing)
    if finish_status == "canceled":
        return


@app.get("/servers")
def list_servers():
    return {"servers": server_manager.list(), "defaultServerName": server_manager.primary["name"]}


@app.get("/concerts")
def list_concerts():
    return {"concerts": concert_store.list()}


@app.get("/concerts/{concert_name:path}")
def get_concert(concert_name: str):
    try:
        return concert_store.load(concert_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/concerts-by-id/{concert_id}")
def get_concert_by_id(concert_id: str):
    try:
        return concert_store.load_by_id(concert_id)
    except (ValueError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.post("/concerts")
def save_concert(req: ConcertSaveRequest):
    try:
        return concert_store.save(
            req.concertId, req.name, req.nodes, req.edges, req.globalVariables, req.inputVariables, req.version
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _deployment_error(exc):
    if isinstance(exc, VersionMismatchError):
        return HTTPException(status_code=409, detail=exc.detail)
    if isinstance(exc, FileExistsError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, FileNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


def _deployment_payload(req):
    return {
        "concertId": req.concertId,
        "version": req.version,
        "name": req.name,
        "nodes": req.nodes,
        "edges": req.edges,
        "globalVariables": req.globalVariables,
        "inputVariables": req.inputVariables,
    }


@app.get("/deployments")
def list_deployments():
    try:
        return deployment_store.list()
    except (ValueError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.get("/deployments/file")
def get_deployment_file(kind: str, path: str):
    try:
        return deployment_store.load_file(kind, path)
    except (ValueError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.post("/deployments/rehearsals", status_code=201)
def deploy_rehearsal(req: DeploymentRequest):
    try:
        return deployment_store.deploy(
            _deployment_payload(req),
            source_name=req.sourceName,
            deployment_name=req.deploymentPath,
            allow_version_mismatch=req.allowVersionMismatch,
        )
    except (ValueError, FileExistsError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.post("/deployments/promote")
def promote_deployment(req: DeploymentNameRequest):
    try:
        return deployment_store.promote(req.name)
    except (ValueError, FileExistsError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.post("/deployments/rollback")
def rollback_deployment(req: RollbackRequest):
    try:
        return deployment_store.rollback(req.backupPath)
    except (ValueError, FileExistsError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.post("/deployments/move")
def move_deployment(req: DeploymentMoveRequest):
    try:
        return deployment_store.move(req.name, req.directory)
    except (ValueError, FileExistsError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.delete("/deployments")
def delete_deployment(req: DeploymentDeleteRequest):
    try:
        return deployment_store.delete(req.kind, req.path)
    except (ValueError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.post("/deployments/transactions/{transaction_id}/prepare", status_code=201)
def prepare_deployment(transaction_id: str, req: DeploymentRequest):
    try:
        return deployment_store.prepare(
            transaction_id,
            _deployment_payload(req),
            source_name=req.sourceName,
            deployment_name=req.deploymentPath,
            allow_version_mismatch=req.allowVersionMismatch,
        )
    except (ValueError, FileExistsError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.post("/deployments/transactions/{transaction_id}/commit")
def commit_deployment(transaction_id: str):
    try:
        return deployment_store.commit(transaction_id)
    except (ValueError, FileExistsError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.delete("/deployments/transactions/{transaction_id}")
def compensate_deployment(transaction_id: str):
    try:
        return deployment_store.compensate(transaction_id)
    except (ValueError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.post("/deployments/transactions/{transaction_id}/finalize")
def finalize_deployment(transaction_id: str):
    try:
        return deployment_store.finalize(transaction_id)
    except (ValueError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.get("/deployments/directories")
def list_deployment_directories():
    return {"directories": deployment_store.directories()}


@app.post("/deployments/directories", status_code=201)
def create_deployment_directory(req: DeploymentDirectoryRequest):
    try:
        return deployment_store.create_directory(req.directory)
    except ValueError as exc:
        raise _deployment_error(exc) from exc


@app.get("/stage-resources")
def list_stage_resources():
    return {"resources": resource_store.list_stage()}


@app.post("/stage-resources", status_code=201)
def create_stage_resource(req: StageResourceRequest):
    try:
        return resource_store.create_stage(req.kind, req.name)
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/stage-resources/{kind}/{name}/schema")
def get_stage_resource_schema(kind: str, name: str):
    try:
        dataframe = resource_store.read(kind, "stage", name)
        return {
            "columns": [
                {"name": str(column), "type": str(dtype)}
                for column, dtype in zip(dataframe.columns, dataframe.dtypes)
            ]
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/stage-resources/{kind}/{name}/data")
def get_stage_resource_data(kind: str, name: str):
    try:
        return _dataframe_payload(resource_store.read(kind, "stage", name))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/stage-resources/{kind}/{name}")
def delete_stage_resource(kind: str, name: str):
    try:
        resource_store.delete_stage(kind, name)
        return {"deleted": True}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc



@app.get("/connections")
def list_connections():
    return {"connections": [{"name": name} for name in list_connection_names()]}


@app.post("/db-read/describe")
def describe_db_read(req: DbReadDescribeRequest):
    connection = req.connection or ""
    if not connection:
        return {
            "columns": [],
            "source": "oracle",
            "error": "No Oracle connection selected.",
        }

    try:
        sql = _rewrite_sql_variables(req.sql)
        params = _sql_bind_defaults(sql, req.params)
        return {
            "columns": describe_oracle_query(connection, sql, params=params),
            "source": "oracle",
            "error": None,
        }
    except OracleUnavailable as exc:
        return {
            "columns": [],
            "source": "oracle",
            "error": str(exc),
        }


@app.post("/schema/infer")
def infer_schema(req: SchemaInferRequest):
    params = _runtime_params(req.globalVariables, req.inputVariables, req.params)
    return infer_concert_columns(
        req.nodes,
        req.edges,
        params=params,
        start_node_id=req.startNodeId,
    )


@app.post("/run")
def run(req: RunRequest, request: Request):
    return _queue_run(
        concert_name=req.concertName,
        concert_id=req.concertId,
        nodes=req.nodes,
        edges=req.edges,
        mode=req.mode,
        selected=req.selected,
        replay=req.replay,
        replay_id=req.replayId,
        params=req.params,
        global_variables=req.globalVariables,
        input_variables=req.inputVariables,
        trigger="manual",
        request=request,
    )


def _queue_run(
    concert_name,
    concert_id,
    nodes,
    edges,
    mode="all",
    selected=None,
    replay=False,
    replay_id=None,
    params=None,
    global_variables=None,
    input_variables=None,
    trigger="manual",
    request=None,
):
    concert_name = os.path.basename(ConcertStore.safe_path_name(concert_name))
    concert_id = ConcertStore.validate_id(concert_id)
    if not concert_name:
        raise HTTPException(status_code=400, detail="concertName is required")
    if replay and not replay_id:
        raise HTTPException(status_code=400, detail="replayId is required for replay runs")

    params = _runtime_params(global_variables, input_variables, params)
    caller_input_params = _params_for_variables(input_variables, params)
    run_started_at = time.time()
    run_id = str(uuid4())
    build_start = time.time()
    task_map = build_concert(
        nodes,
        edges,
        params=params,
        concert_root=CONCERT_ROOT,
        replay_root=REPLAY_ROOT,
        call_stack=[concert_name],
        call_ids=[concert_id],
        caller_input_params=caller_input_params,
        resource_store=resource_store,
        run_id=run_id,
    )
    build_duration_ms = int((time.time() - build_start) * 1000)

    if mode == "selected":
        if not selected or selected not in task_map:
            raise HTTPException(status_code=400, detail="selected node is required for selected mode")
        run_tasks = collect_dependencies(task_map[selected])
        run_task_ids = {task.id for task in run_tasks}
        roots = [
            task
            for task in run_tasks
            if not task.internal_loop_task
            and not any(parent.id in run_task_ids and not parent.internal_loop_task for parent in task.parents)
        ]
    else:
        run_task_ids = set(task_map.keys())
        roots = [
            task
            for task in task_map.values()
            if not task.internal_loop_task
            and not any(not parent.internal_loop_task for parent in task.parents)
        ]

    if not roots:
        raise HTTPException(status_code=400, detail="Concert has no executable root nodes")

    run_timestamp = _run_timestamp()
    output_replay_id = None if replay else ReplayDataStore.replay_id_for_timestamp(run_timestamp)
    node_states = _initial_node_states(task_map)
    for node_id, state in node_states.items():
        if node_id not in run_task_ids:
            state["status"] = "skipped"
            state["error"] = "Not included in selected run."
    cache_node_states = {
        node_id: {
            "id": node_id,
            "name": state["name"],
            "type": state["type"],
            "status": state["status"],
            "logs": state["logs"],
            "error": state["error"],
            "durationMs": state["durationMs"],
            "loopIterations": state["loopIterations"],
            "cacheDurationMs": state["cacheDurationMs"],
            "updatedAt": state["updatedAt"],
            "kind": "none",
        }
        for node_id, state in node_states.items()
    }

    source_metadata = _run_source_metadata(trigger, request)
    replay_metadata = {
        "id": output_replay_id or replay_id,
        "concertName": concert_name,
        "createdAt": _now(),
        "trigger": trigger,
        **source_metadata,
        "params": params,
        "inputParams": caller_input_params,
        "globalVariables": global_variables or [],
        "inputVariables": input_variables or [],
    }
    source_replay_id = replay_id if replay else output_replay_id
    cache_id = CacheDataStore._safe_name(source_replay_id)
    cache_metadata = {
        "id": cache_id,
        "runId": run_id,
        "concertName": concert_name,
        "createdAt": _now(),
        "mode": mode,
        "selected": selected,
        "replay": replay,
        "sourceReplayId": source_replay_id,
        "trigger": trigger,
        **source_metadata,
        "params": params,
        "inputParams": caller_input_params,
        "globalVariables": global_variables or [],
        "inputVariables": input_variables or [],
        "status": "queued",
        "nodes": cache_node_states,
        "timing": {
            "totalElapsedMs": 0,
            "buildConcertMs": build_duration_ms,
            "executionMs": 0,
            "replaySaveMs": 0,
            "executionReplayMs": 0,
            "cacheSaveMs": 0,
            "executionReplayCacheMs": 0,
        },
    }

    with runs_lock:
        runs[run_id] = {
            "id": run_id,
            "concertName": concert_name,
            "status": "queued",
            "nodes": node_states,
            "createdAt": _now(),
            "updatedAt": _now(),
            "finishedAt": None,
            "timing": {
                "totalElapsedMs": 0,
                "buildConcertMs": build_duration_ms,
                "executionMs": 0,
                "replaySaveMs": 0,
                "executionReplayMs": 0,
                "cacheSaveMs": 0,
                "executionReplayCacheMs": 0,
            },
            "trigger": trigger,
            **source_metadata,
            "params": params,
            "globalVariables": global_variables or [],
            "inputVariables": input_variables or [],
            "executor": {
                "id": EXECUTOR_ID,
                "replayRoot": os.path.abspath(REPLAY_ROOT),
            },
            "replay": {
                "enabled": replay,
                "selectedReplayId": replay_id,
                "outputReplayId": output_replay_id,
                "folder": f"{concert_name}/{replay_id if replay else output_replay_id}",
            },
            "cache": {
                "enabled": True,
                "cacheId": cache_id,
                "folder": f"{concert_name}/{source_replay_id}/cache",
            },
        }

    Thread(
        target=_run_in_background,
        args=(
            run_started_at,
            run_id,
            concert_name,
            task_map,
            roots,
            replay,
            replay_id,
            run_timestamp,
            run_task_ids,
            replay_metadata,
            cache_metadata,
        ),
        daemon=True,
    ).start()
    return {
        "runId": run_id,
        "status": "queued",
        "replayId": output_replay_id,
        "cacheId": cache_id,
        "executorId": EXECUTOR_ID,
        "replayRoot": os.path.abspath(REPLAY_ROOT),
    }


@app.post("/scheduler/run")
def scheduler_run(req: TriggerRunRequest, request: Request):
    try:
        concert = concert_store.load(req.concertName)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _queue_run(
        concert_name=concert.get("name") or req.concertName,
        concert_id=concert["concertId"],
        nodes=concert["nodes"],
        edges=concert["edges"],
        mode=req.mode,
        selected=req.selected,
        params=req.params,
        global_variables=concert["globalVariables"],
        input_variables=concert["inputVariables"],
        trigger="scheduler",
        request=request,
    )


@app.post("/events/trigger")
def event_trigger(req: TriggerRunRequest, request: Request):
    try:
        concert = concert_store.load(req.concertName)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return _queue_run(
        concert_name=concert.get("name") or req.concertName,
        concert_id=concert["concertId"],
        nodes=concert["nodes"],
        edges=concert["edges"],
        mode=req.mode,
        selected=req.selected,
        params=req.params,
        global_variables=concert["globalVariables"],
        input_variables=concert["inputVariables"],
        trigger="event",
        request=request,
    )


@app.get("/runs/{run_id}")
def get_run(run_id: str, includeData: bool = Query(default=False)):
    with runs_lock:
        if run_id in runs:
            return _run_response(runs[run_id], include_data=includeData)
    try:
        return CacheDataStore.load_run(REPLAY_ROOT, run_id)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc


@app.get("/runs/{run_id}/nodes/{node_id}/data")
def get_run_node_data(run_id: str, node_id: str):
    with runs_lock:
        if run_id in runs:
            node = runs[run_id].get("nodes", {}).get(node_id)
            if node is None:
                raise HTTPException(status_code=404, detail="node not found")
            result = node.get("result")
            if result is not None:
                return {
                    "runId": run_id,
                    "nodeId": node_id,
                    "result": result,
                }
    try:
        return {
            "runId": run_id,
            "nodeId": node_id,
            "result": CacheDataStore.load_node_result(REPLAY_ROOT, run_id, node_id),
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/runs/{run_id}/cancel")
def cancel_run(run_id: str):
    with runs_lock:
        if run_id not in runs:
            raise HTTPException(status_code=404, detail="run not found")
        run_state = runs[run_id]
        if run_state["status"] in ("success", "error", "canceled"):
            return _run_response(run_state, include_data=False)
        executor = executors.get(run_id)
        run_state["status"] = "canceled"
        run_state["updatedAt"] = _now()
        run_state["finishedAt"] = _now()
        for node in run_state["nodes"].values():
            if node["status"] in ("pending", "running"):
                node["status"] = "skipped"
                node["error"] = "Run canceled."
                node["updatedAt"] = _now()

    if executor:
        executor.cancel()

    with runs_lock:
        return _run_response(runs[run_id], include_data=False)


@app.get("/replays")
def list_replays(concertName: Optional[str] = Query(default=None)):
    return {
        "replays": ReplayDataStore.list_replays(
            REPLAY_ROOT,
            concert_name=concertName,
            cache_lookup=lambda concert_name, replay_id: CacheDataStore.latest_for_replay(
                REPLAY_ROOT,
                concert_name,
                replay_id,
            ),
        )
    }


@app.get("/replays/cache")
def open_replay_cache(concertName: str = Query(...), replayId: str = Query(...)):
    cache = CacheDataStore.latest_for_replay(REPLAY_ROOT, concertName, replayId)
    if not cache.get("available"):
        raise HTTPException(status_code=404, detail="cache not found")
    return {"run": CacheDataStore.load_run(REPLAY_ROOT, cache["cacheId"])}


@app.delete("/replays/cache")
def clear_replay_cache(concertName: str = Query(...), replayId: str = Query(...)):
    deleted = CacheDataStore.clear_for_replay(REPLAY_ROOT, concertName, replayId)
    if not deleted:
        raise HTTPException(status_code=404, detail="cache not found")
    return {"deleted": True}


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
