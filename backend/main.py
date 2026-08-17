from datetime import datetime, timedelta
import json
import multiprocessing
import os
import re
import socket
import shutil
import tempfile
import time
import zipfile
from threading import Lock, Thread
from typing import Any, Optional

import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, ConfigDict, Field

from cache_data_store import CacheDataStore
from app_config import config_int
from concert_builder import selected_concert_graph
from concert_store import ConcertStore
from node_run_validation import validate_run_nodes, validation_message
from deployment_store import DeploymentMismatchError, DeploymentStore
from oracle_client import (
    OracleUnavailable,
    describe_oracle_query,
    list_admin_connections,
    list_connection_names,
    save_admin_connections,
    test_connection_settings,
)
from replay_data_store import ReplayDataStore
from resource_store import ResourceStore
from server_manager import ServerManager
from schema_inference import infer_concert_columns
from timer_manager import TimerManager
from storage_retention import StorageRetentionManager
from run_process import ConcertRunProcess
from variable_types import runtime_params as _typed_runtime_params

BACKEND_ROOT = os.environ.get(
    "METRONOME_DATA_DIR",
    os.path.dirname(os.path.abspath(__file__)),
)
REPLAY_ROOT = os.path.join(BACKEND_ROOT, "replay")
PLAYING_ROOT = os.path.join(BACKEND_ROOT, "playings")
STAGE_ROOT = os.path.join(BACKEND_ROOT, "stage")
TMP_ROOT = os.path.join(BACKEND_ROOT, "tmp")
SERVERS_PATH = os.path.join(BACKEND_ROOT, "servers.json")
TIMERS_PATH = os.path.join(BACKEND_ROOT, "timers.json")
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
    lastCommitId: Optional[str] = None
    commitId: Optional[str] = None
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


class EventRunRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    concertName: str
    params: dict[str, Any] = Field(default_factory=dict)


class TimerRequest(BaseModel):
    id: Optional[str] = None
    name: str
    concertName: str
    intervalSeconds: int = Field(ge=1)
    firstRunAt: str
    enabled: bool = True
    params: dict[str, Any] = Field(default_factory=dict)


class TimerBatchRequest(BaseModel):
    timers: list[TimerRequest] = Field(default_factory=list)


class AdminConnectionRequest(BaseModel):
    originalName: str = ""
    name: str
    user: str
    password: str = ""
    dsn: str
    enable: bool = True
    pm: bool = False


class AdminConnectionsRequest(BaseModel):
    connections: list[AdminConnectionRequest] = Field(default_factory=list)


class AdminConnectionTestRequest(AdminConnectionRequest):
    pass


class DbReadDescribeRequest(BaseModel):
    connection: Optional[str] = None
    sql: str = ""
    params: dict[str, Any] = Field(default_factory=dict)
    globalVariables: list = Field(default_factory=list)
    inputVariables: list = Field(default_factory=list)


class SchemaInferRequest(BaseModel):
    nodes: list
    edges: list
    globalVariables: list = Field(default_factory=list)
    inputVariables: list = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)
    startNodeId: Optional[str] = None


class DataFilterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    column: str
    operator: str
    value: str = ""


class DataSortRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    column: str
    direction: str


class DataQueryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=1000, ge=1, le=1000)
    filters: list[DataFilterRequest] = Field(default_factory=list)
    sorts: list[DataSortRequest] = Field(default_factory=list)


class StageResourceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str


class DeploymentRequest(BaseModel):
    concertId: str
    lastCommitId: Optional[str] = None
    commitId: str
    sourceName: str
    deploymentPath: str
    allowMismatch: bool = False
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


def _dataframe_payload(dataframe, limit=1000, total_rows=None):
    snapshot = dataframe.head(limit).copy()
    snapshot.columns = [str(column) for column in snapshot.columns]
    snapshot = snapshot.astype(object).where(pd.notnull(snapshot), None)
    snapshot = snapshot.replace({float("inf"): None, float("-inf"): None})
    return {
        "kind": "dataframe",
        "rows": int(len(dataframe) if total_rows is None else total_rows),
        "columns": list(snapshot.columns),
        "dtypes": {
            str(column): str(dtype)
            for column, dtype in zip(dataframe.columns, dataframe.dtypes)
        },
        "data": snapshot.to_dict(orient="records"),
        "dataLimit": limit,
        "truncated": (len(dataframe) if total_rows is None else total_rows) > limit,
    }


def _variable_name(item):
    name = str(item.get("name", "") if isinstance(item, dict) else "").strip()
    return name[1:] if name.startswith("$") else name


def _runtime_params(global_variables=None, input_variables=None, params=None):
    return _typed_runtime_params(global_variables, input_variables, params)


def _resolve_connection(connection, params):
    value = str(connection or "").strip()
    if value.startswith("$"):
        return str((params or {}).get(value[1:], "") or "")
    return value


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
            "sourceDetail": (
                f"User run from {client_host}" if client_host else "User run"
            ),
            "callerName": client_host or "",
            "clientIp": client_host,
            "executedBy": {
                "type": "manual",
                "sourceKind": "user",
                "clientIp": client_host,
            },
        }
    if trigger == "timer":
        return {
            "sourceKind": "timer",
            "sourceLabel": "Timer",
            "sourceDetail": "Timer-triggered run",
            "callerName": "timer",
            "executedBy": {"type": "timer"},
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
    allow_origins=[
        "null",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

runs = {}
runs_lock = Lock()
run_identity_lock = Lock()
last_run_timestamp = None
execution_processes = {}
execution_cancel_events = {}
concert_store = ConcertStore(PLAYING_ROOT)
deployment_store = DeploymentStore(BACKEND_ROOT)
resource_store = ResourceStore(STAGE_ROOT, TMP_ROOT)
server_manager = ServerManager(SERVERS_PATH)
timer_manager = TimerManager(
    TIMERS_PATH,
    run_callback=lambda concert_name, params: _queue_saved_concert(
        concert_name,
        params,
        trigger="timer",
        cache_enabled=False,
    ),
)
retention_manager = StorageRetentionManager(
    REPLAY_ROOT,
    STAGE_ROOT,
)


@app.on_event("startup")
def start_timer_manager():
    retention_manager.start()
    timer_manager.start()


@app.on_event("shutdown")
def stop_timer_manager():
    timer_manager.stop()
    retention_manager.stop()
    with runs_lock:
        active = list(execution_processes.items())
        cancel_events = dict(execution_cancel_events)
    for run_id, process in active:
        event = cancel_events.get(run_id)
        if event is not None:
            event.set()
        process.join(timeout=5)
        if process.is_alive():
            process.terminate()
            process.join(timeout=2)


def _run_timestamp():
    global last_run_timestamp
    with run_identity_lock:
        current = datetime.now()
        if last_run_timestamp is not None and current <= last_run_timestamp:
            current = last_run_timestamp + timedelta(microseconds=1)
        last_run_timestamp = current
        return current.strftime("%Y%m%d_%H%M%S_%f")


def _now():
    return datetime.utcnow().isoformat() + "Z"


def _run_response(run_state, include_data=False):
    def node_without_result(node):
        next_node = {key: value for key, value in node.items() if key != "result"}
        result = node.get("result")
        if isinstance(result, dict) and result.get("kind") == "dataframe":
            next_node["rows"] = result.get("rows")
        return next_node

    response = {
        **run_state,
        "nodes": {
            node_id: ({**node} if include_data else node_without_result(node))
            for node_id, node in run_state.get("nodes", {}).items()
        },
    }
    return response


@app.get("/servers")
def list_servers():
    servers = server_manager.list()
    return {
        "servers": servers,
        "defaultServerName": server_manager.primary["name"],
    }


@app.get("/playings")
def list_playings():
    return {"playings": concert_store.list()}


@app.get("/playings/{concert_name:path}")
def get_playing(concert_name: str):
    try:
        return concert_store.load(concert_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/playings-by-id/{concert_id}")
def get_playing_by_id(concert_id: str):
    try:
        return concert_store.load_by_id(concert_id)
    except (ValueError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.get("/playings-by-name/{concert_name}")
def get_playing_by_name(concert_name: str):
    try:
        return concert_store.load_by_basename(concert_name)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/playings")
def save_playing(req: ConcertSaveRequest):
    try:
        return concert_store.save(
            req.concertId,
            req.lastCommitId,
            req.commitId,
            req.name,
            req.nodes,
            req.edges,
            req.globalVariables,
            req.inputVariables,
            req.version,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _deployment_error(exc):
    if isinstance(exc, DeploymentMismatchError):
        return HTTPException(status_code=409, detail=exc.detail)
    if isinstance(exc, FileExistsError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, FileNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    return HTTPException(status_code=400, detail=str(exc))


def _deployment_payload(req):
    return {
        "concertId": req.concertId,
        "lastCommitId": req.lastCommitId,
        "commitId": req.commitId,
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
            allow_mismatch=req.allowMismatch,
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
            allow_mismatch=req.allowMismatch,
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


@app.delete("/deployments/directories")
def delete_deployment_directory(req: DeploymentDirectoryRequest):
    try:
        return deployment_store.delete_directory(req.directory)
    except (ValueError, FileNotFoundError) as exc:
        raise _deployment_error(exc) from exc


@app.get("/stage-resources")
def list_stage_resources():
    return {"resources": resource_store.list_stage()}


@app.post("/stage-resources", status_code=201)
def create_stage_resource(req: StageResourceRequest):
    try:
        return resource_store.create_stage(req.name)
    except FileExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/stage-resources/{name}/schema")
def get_stage_resource_schema(name: str):
    try:
        return {"columns": resource_store.schema("stage", name)}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/stage-resources/{name}/data")
def get_stage_resource_data(name: str):
    try:
        dataframe, total_rows = resource_store.preview(
            "stage",
            name,
            limit=1000,
        )
        return _dataframe_payload(
            dataframe,
            limit=1000,
            total_rows=total_rows,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.delete("/stage-resources/{name}")
def delete_stage_resource(name: str):
    try:
        resource_store.delete_stage(name)
        return {"deleted": True}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/connections")
def list_connections():
    return {"connections": [{"name": name} for name in list_connection_names()]}


@app.get("/admin/connections")
def list_admin_connection_settings():
    try:
        return {"connections": list_admin_connections()}
    except (ValueError, OracleUnavailable) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.put("/admin/connections")
def save_admin_connection_settings(req: AdminConnectionsRequest):
    try:
        items = [item.model_dump() for item in req.connections]
        return {"connections": save_admin_connections(items)}
    except (ValueError, OracleUnavailable) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/admin/connections/test")
def test_admin_connection(req: AdminConnectionTestRequest):
    try:
        return test_connection_settings(
            req.name, req.user, req.password, req.dsn, req.originalName
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/db-read/describe")
def describe_db_read(req: DbReadDescribeRequest):
    default_params = _runtime_params(req.globalVariables, req.inputVariables)
    connection = _resolve_connection(req.connection, default_params)
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
    params = _runtime_params(req.globalVariables, req.inputVariables)
    nodes = [node for node in req.nodes if node.get("type") != "text"]
    node_ids = {node["id"] for node in nodes}
    edges = [
        edge
        for edge in req.edges
        if edge.get("source") in node_ids and edge.get("target") in node_ids
    ]
    return infer_concert_columns(
        nodes,
        edges,
        params=params,
        start_node_id=req.startNodeId if req.startNodeId in node_ids else None,
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


def _watch_concert_process(run_id, process, event_queue):
    terminal = False
    while not terminal:
        try:
            event = event_queue.get(timeout=0.25)
        except Exception:
            if not process.is_alive():
                event = {"kind": "failed", "error": f"Concert process exited with code {process.exitcode}."}
            else:
                continue
        kind = event.get("kind")
        with runs_lock:
            run_state = runs.get(run_id)
            if run_state is None:
                terminal = True
                continue
            if kind == "started":
                run_state["status"] = "running"
                run_state["executor"]["pid"] = event.get("pid")
                if event.get("execution"):
                    run_state["execution"] = event["execution"]
                run_state["cache"]["cacheId"] = event.get("cacheId")
                run_state["replay"]["outputReplayId"] = event.get("replayId")
            elif kind == "node":
                node = run_state["nodes"].get(event.get("nodeId"))
                if node is not None and run_state["status"] != "canceled":
                    node["status"] = event.get("status")
                    node["logs"] = event.get("logs") or node.get("logs", "")
                    node["error"] = event.get("error")
                    node["durationMs"] = event.get("durationMs")
                    node["cacheDurationMs"] = event.get("cacheDurationMs")
                    node["loopIterations"] = event.get("loopIterations")
                    if event.get("result") is not None:
                        node["result"] = event["result"]
                    node["updatedAt"] = _now()
            elif kind in {"finished", "failed"}:
                if run_state["status"] != "canceled":
                    run_state["status"] = event.get("status", "error") if kind == "finished" else "error"
                run_state["error"] = event.get("error")
                run_state["updatedAt"] = _now()
                run_state["finishedAt"] = _now()
                run_state["timing"] = event.get("timing") or run_state.get("timing")
                for node in run_state["nodes"].values():
                    if node["status"] in {"pending", "running"}:
                        node["status"] = "skipped"
                        node["error"] = event.get("error") or "Run finished before this node became executable."
                terminal = True
            run_state["updatedAt"] = _now()
    # The terminal message is emitted before child-side Executor/Oracle cleanup.
    # Keep the handle registered until the process has actually exited.
    process.join()
    completed_state = None
    with runs_lock:
        run_state = runs.get(run_id)
        if run_state is not None:
            completed_state = _run_response(run_state, include_data=False)
        execution_processes.pop(run_id, None)
        execution_cancel_events.pop(run_id, None)
        runs.pop(run_id, None)
    if completed_state is not None and completed_state.get("trigger") == "timer":
        node_error = next(
            (
                node.get("error")
                for node in completed_state.get("nodes", {}).values()
                if node.get("error")
            ),
            None,
        )
        if not completed_state.get("error") and node_error:
            completed_state["error"] = node_error
        timer_manager.complete_run(run_id, completed_state)
    event_queue.close()
    event_queue.join_thread()


def _queue_run(
    concert_name,
    concert_id=None,
    nodes=None,
    edges=None,
    mode="all",
    selected=None,
    replay=False,
    replay_id=None,
    params=None,
    global_variables=None,
    input_variables=None,
    trigger="manual",
    request=None,
    cache_enabled=True,
):
    del cache_enabled
    concert_name = ConcertStore.safe_path_name(concert_name)
    concert_id = ConcertStore.validate_id(concert_id)
    if not isinstance(nodes, list):
        raise ValueError("Concert nodes must be an array.")
    if not isinstance(edges, list):
        raise ValueError("Concert edges must be an array.")
    if not isinstance(global_variables, list):
        raise ValueError("Concert globalVariables must be an array.")
    if not isinstance(input_variables, list):
        raise ValueError("Concert inputVariables must be an array.")
    concert = {
        "concertId": concert_id,
        "name": concert_name,
        "nodes": nodes,
        "edges": edges,
        "globalVariables": global_variables,
        "inputVariables": input_variables,
    }
    if replay and not replay_id:
        raise HTTPException(status_code=400, detail="replayId is required for replay runs")
    if mode not in {"all", "selected"}:
        raise HTTPException(status_code=400, detail=f"Invalid run mode: {mode}")
    selected_nodes = [
        node for node in concert["nodes"] if node.get("type") != "text"
    ]
    if mode == "selected":
        selected_nodes, _selected_edges = selected_concert_graph(
            selected_nodes,
            concert["edges"],
            selected,
        )
    if trigger == "manual":
        validation_errors = validate_run_nodes(selected_nodes, concert["edges"])
        if validation_errors:
            raise HTTPException(
                status_code=400,
                detail={
                    "code": "INVALID_RUN_NODES",
                    "message": validation_message(validation_errors),
                    "nodes": validation_errors,
                },
            )
    ConcertStore.validate_nodes(nodes)
    input_values = dict(params or {})
    run_timestamp = _run_timestamp()
    run_id = f"{concert_name}_{run_timestamp}"
    selected_node_ids = {node["id"] for node in selected_nodes}
    node_states = {
        node["id"]: {
            "id": node["id"], "name": node["data"]["name"], "type": node.get("type", ""),
            "status": "pending" if node["id"] in selected_node_ids else "skipped",
            "logs": "" if node["id"] in selected_node_ids else "Not included in the selected run.",
            "error": None, "result": None,
            "durationMs": None, "cacheDurationMs": None, "loopIterations": None, "updatedAt": _now(),
        }
        for node in concert["nodes"] if node.get("type") != "text"
    }
    source_metadata = _run_source_metadata(trigger, request)
    execution_settings = {
        "workers": config_int("executor", "workers"),
        "oraclePoolMax": config_int("oracle", "poolMax"),
    }
    mp_context = multiprocessing.get_context("spawn")
    event_queue = mp_context.Queue()
    cancel_event = mp_context.Event()
    context = {
        "runId": run_id, "trigger": trigger, "mode": mode, "selected": selected,
        "replay": replay, "replayId": replay_id, "runTimestamp": run_timestamp,
        "sourceMetadata": source_metadata,
        "executionSettings": execution_settings,
        "playingRoot": PLAYING_ROOT, "replayRoot": REPLAY_ROOT, "stageRoot": STAGE_ROOT,
    }
    process = ConcertRunProcess(
        concert,
        input_values,
        run_context=context,
        event_queue=event_queue,
        cancel_event=cancel_event,
    )
    with runs_lock:
        runs[run_id] = {
            "id": run_id, "concertName": concert_name, "status": "queued", "nodes": node_states,
            "createdAt": _now(), "updatedAt": _now(), "finishedAt": None,
            "timing": {"totalElapsedMs": 0, "processCreateMs": 0, "oraclePoolInitMs": 0, "buildConcertMs": 0, "executionMs": 0, "replaySaveMs": 0, "cacheSaveMs": 0},
            "trigger": trigger, **source_metadata, "params": input_values,
            "globalVariables": concert.get("globalVariables") or [], "inputVariables": concert.get("inputVariables") or [],
            "executor": {"id": EXECUTOR_ID, "pid": None, "replayRoot": os.path.abspath(REPLAY_ROOT)},
            "execution": execution_settings,
            "replay": {"enabled": replay, "selectedReplayId": replay_id, "outputReplayId": None},
            "cache": {"enabled": trigger == "manual", "cacheId": None},
        }
        execution_processes[run_id] = process
        execution_cancel_events[run_id] = cancel_event
    try:
        context["processStartRequestedAt"] = time.time()
        process.start()
    except Exception:
        with runs_lock:
            runs.pop(run_id, None)
            execution_processes.pop(run_id, None)
            execution_cancel_events.pop(run_id, None)
        event_queue.close()
        event_queue.join_thread()
        raise
    Thread(
        target=_watch_concert_process,
        args=(run_id, process, event_queue),
        name=f"concert-monitor-{run_id}", daemon=True,
    ).start()
    return {
        "runId": run_id, "status": "queued", "nodes": node_states,
        "replayId": None, "cacheId": None,
        "executorId": EXECUTOR_ID, "replayRoot": os.path.abspath(REPLAY_ROOT),
        "execution": execution_settings,
    }


def _queue_saved_concert(
    concert_name,
    params,
    *,
    trigger,
    request=None,
    cache_enabled=True,
):
    concert = concert_store.load(concert_name)
    return _queue_run(
        concert_name=concert["name"],
        concert_id=concert["concertId"],
        nodes=concert["nodes"],
        edges=concert["edges"],
        params=params,
        global_variables=concert["globalVariables"],
        input_variables=concert["inputVariables"],
        trigger=trigger,
        request=request,
        cache_enabled=cache_enabled,
    )


@app.get("/timers")
def list_timers():
    return {"timers": timer_manager.list()}


@app.put("/timers")
def save_timers(req: TimerBatchRequest):
    try:
        items = [item.model_dump() for item in req.timers]
        for item in items:
            concert_store.load(item["concertName"])
        return {"timers": timer_manager.replace_all(items)}
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/events/trigger")
def event_trigger(req: EventRunRequest, request: Request):
    try:
        return _queue_saved_concert(
            req.concertName,
            req.params,
            trigger="event",
            request=request,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid Concert: {exc}") from exc


@app.get("/runs/{run_id}")
def get_run(
    run_id: str,
    concertName: str = Query(...),
    includeData: bool = Query(default=False),
):
    with runs_lock:
        if run_id in runs:
            return _run_response(runs[run_id], include_data=includeData)
    try:
        return CacheDataStore.load_run(
            REPLAY_ROOT,
            run_id,
            concert_name=concertName,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail="run not found") from exc


@app.get("/runs/{run_id}/nodes/{node_id}/data")
def get_run_node_data(
    run_id: str,
    node_id: str,
    concertName: str = Query(...),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=1000, ge=1, le=1000),
):
    cache_id = run_id
    with runs_lock:
        if run_id in runs:
            run_state = runs[run_id]
            node = run_state.get("nodes", {}).get(node_id)
            if node is None:
                raise HTTPException(status_code=404, detail="node not found")
            cache_id = run_state.get("cache", {}).get("cacheId") or run_id
            result = node.get("result")
            if result is not None and result.get("kind") != "dataframe":
                return {
                    "runId": run_id,
                    "nodeId": node_id,
                    "result": result,
                }
    try:
        return {
            "runId": run_id,
            "nodeId": node_id,
            "result": CacheDataStore.load_node_result(
                REPLAY_ROOT,
                cache_id,
                node_id,
                max_grid_rows=limit,
                offset=offset,
                concert_name=concertName,
            ),
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/runs/{run_id}/nodes/{node_id}/data/query")
def query_run_node_data(
    run_id: str,
    node_id: str,
    req: DataQueryRequest,
    concertName: str = Query(...),
):
    cache_id = run_id
    with runs_lock:
        if run_id in runs:
            run_state = runs[run_id]
            if node_id not in run_state.get("nodes", {}):
                raise HTTPException(status_code=404, detail="node not found")
            cache_id = run_state.get("cache", {}).get("cacheId") or run_id
    try:
        return {
            "runId": run_id,
            "nodeId": node_id,
            "result": CacheDataStore.query_node_result(
                REPLAY_ROOT,
                cache_id,
                node_id,
                offset=req.offset,
                limit=req.limit,
                filters=[item.model_dump() for item in req.filters],
                sorts=[item.model_dump() for item in req.sorts],
                concert_name=concertName,
            ),
        }
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/opl/model", response_class=PlainTextResponse)
def get_opl_model(
    concertName: str = Query(...),
    nodeId: str = Query(...),
    format: str = Query(default="lp", pattern="^(lp|mps)$"),
    cacheId: Optional[str] = Query(default=None),
    replayId: Optional[str] = Query(default=None),
):
    if not cacheId and not replayId:
        raise HTTPException(status_code=400, detail="cacheId or replayId is required")
    if cacheId:
        resolved_cache_id = cacheId
        with runs_lock:
            if cacheId in runs:
                resolved_cache_id = (
                    runs[cacheId].get("cache", {}).get("cacheId") or cacheId
                )
        try:
            return CacheDataStore.load_model_artifact(
                REPLAY_ROOT,
                resolved_cache_id,
                nodeId,
                format,
                concert_name=concertName,
            )
        except FileNotFoundError:
            if not replayId:
                raise HTTPException(status_code=404, detail="OPL model not found")
    try:
        return ReplayDataStore.load_model_artifact(
            REPLAY_ROOT,
            concertName,
            replayId,
            nodeId,
            format,
        )
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
        cancel_event = execution_cancel_events.get(run_id)
        run_state["status"] = "canceled"
        run_state["updatedAt"] = _now()
        run_state["finishedAt"] = _now()
        for node in run_state["nodes"].values():
            if node["status"] in ("pending", "running"):
                node["status"] = "skipped"
                node["error"] = "Run canceled."
                node["updatedAt"] = _now()

    if cancel_event:
        cancel_event.set()

    with runs_lock:
        return _run_response(runs[run_id], include_data=False)


@app.get("/replays")
def list_replays(concertName: Optional[str] = Query(default=None)):
    errors = []
    try:
        replays = ReplayDataStore.list_replays(
            REPLAY_ROOT,
            concert_name=concertName,
            cache_lookup=lambda concert_name, replay_id: CacheDataStore.latest_for_replay(
                REPLAY_ROOT,
                concert_name,
                replay_id,
            ),
            errors=errors,
        )
        return {"replays": replays}
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/replays/export")
def export_replay(concertName: str = Query(...), replayId: str = Query(...)):
    safe_concert = ReplayDataStore._safe_name(concertName)
    safe_replay = ReplayDataStore._safe_replay_id(replayId)
    replay_path = os.path.join(REPLAY_ROOT, safe_concert, safe_replay)
    metadata_path = os.path.join(replay_path, "metadata.json")
    if not os.path.isfile(metadata_path):
        raise HTTPException(status_code=404, detail="replay not found")
    os.makedirs(TMP_ROOT, exist_ok=True)
    fd, archive_path = tempfile.mkstemp(prefix=f".{safe_replay}.", suffix=".zip", dir=TMP_ROOT)
    os.close(fd)
    try:
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for root, directories, files in os.walk(replay_path):
                directories[:] = [item for item in directories if item != "cache"]
                for file_name in files:
                    path = os.path.join(root, file_name)
                    archive.write(path, os.path.relpath(path, replay_path))
        return FileResponse(
            archive_path,
            media_type="application/zip",
            filename=f"{safe_concert}_{safe_replay}.zip",
            background=BackgroundTask(os.unlink, archive_path),
        )
    except Exception:
        try:
            os.unlink(archive_path)
        except FileNotFoundError:
            pass
        raise


def _imported_replay_id(replay_id, source_server_name):
    safe_replay = ReplayDataStore._safe_replay_id(replay_id)
    safe_source_server = ReplayDataStore._safe_name(source_server_name)
    return ReplayDataStore._safe_replay_id(f"{safe_replay}_{safe_source_server}")


@app.get("/replays/import-status")
def replay_import_status(
    concertName: str = Query(...),
    replayId: str = Query(...),
    sourceServerName: str = Query(...),
):
    safe_concert = ReplayDataStore._safe_name(concertName)
    imported_replay_id = _imported_replay_id(replayId, sourceServerName)
    replay_path = os.path.join(REPLAY_ROOT, safe_concert, imported_replay_id)
    return {
        "exists": os.path.isdir(replay_path),
        "replayId": imported_replay_id,
    }


@app.post("/replays/import")
async def import_replay(
    request: Request,
    concertName: str = Query(...),
    replayId: str = Query(...),
    sourceServerName: str = Query(...),
):
    safe_concert = ReplayDataStore._safe_name(concertName)
    safe_replay = ReplayDataStore._safe_replay_id(replayId)
    imported_replay_id = _imported_replay_id(safe_replay, sourceServerName)
    concert_path = os.path.join(REPLAY_ROOT, safe_concert)
    final_path = os.path.join(concert_path, imported_replay_id)
    if os.path.exists(final_path):
        return {"imported": False, "replayId": imported_replay_id}
    os.makedirs(concert_path, exist_ok=True)
    os.makedirs(TMP_ROOT, exist_ok=True)
    fd, archive_path = tempfile.mkstemp(prefix=f".{safe_replay}.", suffix=".zip", dir=TMP_ROOT)
    extract_path = tempfile.mkdtemp(prefix=f".{safe_replay}.", dir=concert_path)
    try:
        with os.fdopen(fd, "wb") as file:
            async for chunk in request.stream():
                file.write(chunk)
            file.flush()
            os.fsync(file.fileno())
        with zipfile.ZipFile(archive_path, "r") as archive:
            for item in archive.infolist():
                relative = item.filename.replace("\\", "/")
                if item.is_dir():
                    continue
                parts = relative.split("/")
                if not relative or relative.startswith("/") or any(part in {"", ".", ".."} for part in parts):
                    raise ValueError(f"Invalid Replay archive path: {relative}")
                if parts[0] == "cache":
                    raise ValueError("Replay archive must not contain Run Cache data.")
                target = os.path.abspath(os.path.join(extract_path, *parts))
                if os.path.commonpath([os.path.abspath(extract_path), target]) != os.path.abspath(extract_path):
                    raise ValueError(f"Invalid Replay archive path: {relative}")
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with archive.open(item, "r") as source, open(target, "wb") as destination:
                    shutil.copyfileobj(source, destination)
        metadata = ReplayDataStore._load_metadata(extract_path)
        if metadata.get("concertName") != safe_concert or metadata.get("id") != safe_replay:
            raise ValueError("Replay archive metadata does not match concertName/replayId.")
        metadata["id"] = imported_replay_id
        metadata["importedFrom"] = {
            "serverName": sourceServerName,
            "replayId": safe_replay,
        }
        with open(os.path.join(extract_path, "metadata.json"), "w", encoding="utf-8") as file:
            json.dump(metadata, file, ensure_ascii=False, allow_nan=True, indent=2)
            file.flush()
            os.fsync(file.fileno())
        os.replace(extract_path, final_path)
        extract_path = None
        return {"imported": True, "replayId": imported_replay_id}
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    finally:
        try:
            os.unlink(archive_path)
        except FileNotFoundError:
            pass
        if extract_path and os.path.isdir(extract_path):
            shutil.rmtree(extract_path)


@app.get("/replays/cache")
def list_replay_caches(concertName: str = Query(...), replayId: str = Query(...)):
    caches = CacheDataStore.list_for_replay(REPLAY_ROOT, concertName, replayId)
    return {"caches": caches}


@app.get("/replays/cache/{cache_id}")
def open_replay_cache(
    cache_id: str,
    concertName: str = Query(...),
    replayId: str = Query(...),
):
    caches = CacheDataStore.list_for_replay(REPLAY_ROOT, concertName, replayId)
    if not any(item["cacheId"] == cache_id for item in caches):
        raise HTTPException(status_code=404, detail="cache not found")
    return {
        "run": CacheDataStore.load_run(
            REPLAY_ROOT,
            cache_id,
            concert_name=concertName,
        )
    }


@app.delete("/replays/cache")
def clear_replay_cache(
    concertName: str = Query(...),
    replayId: str = Query(...),
    cacheId: Optional[str] = Query(default=None),
):
    deleted = CacheDataStore.clear_for_replay(
        REPLAY_ROOT,
        concertName,
        replayId,
        cache_id=cacheId,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="cache not found")
    return {"deleted": True}


@app.delete("/replays/cache/{cache_id}")
def delete_replay_cache(
    cache_id: str,
    concertName: str = Query(...),
    replayId: str = Query(...),
):
    caches = CacheDataStore.list_for_replay(REPLAY_ROOT, concertName, replayId)
    if not any(item["cacheId"] == cache_id for item in caches):
        raise HTTPException(status_code=404, detail="cache not found")
    CacheDataStore.clear_for_replay(
        REPLAY_ROOT,
        concertName,
        replayId,
        cache_id=cache_id,
    )
    return {"deleted": True, "cacheId": cache_id}


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    multiprocessing.freeze_support()
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
