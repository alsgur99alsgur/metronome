from datetime import datetime
import multiprocessing
import os
import time
import traceback

from cache_data_store import CacheDataStore
from concert_builder import build_concert, collect_dependencies, selected_concert_graph
from executor import Executor
from oracle_client import close_all_pools
from replay_data_store import ReplayDataStore
from resource_store import ResourceStore
from variable_types import runtime_params
from thread_local_output import install_thread_local_output, restore_thread_local_output


class _NoReplayStore:
    def save_metadata(self, _metadata):
        return None

    def save_task_result(self, _task, _result, loop_key=None):
        return None

    def load_task_result(self, _task, loop_key=None):
        raise RuntimeError("Replay loading is not enabled.")


class ConcertRunProcess(multiprocessing.Process):
    """Run an immutable Concert request snapshot in a child process."""

    def __init__(self, concert, input_variables, *, run_context, event_queue, cancel_event):
        super().__init__(name=f"concert-{concert['name']}", daemon=True)
        self.concert = concert
        self.input_variables = input_variables
        self.run_context = run_context
        self.event_queue = event_queue
        self.cancel_event = cancel_event

    def run(self):
        process = multiprocessing.current_process()
        process.run_context = self.run_context
        process.event_queue = self.event_queue
        process.cancel_event = self.cancel_event
        run_concert_process(self.concert, self.input_variables)


def _now():
    return datetime.utcnow().isoformat() + "Z"


def _replay_id(timestamp):
    return ReplayDataStore.replay_id_for_timestamp(timestamp)


def run_concert_process(concert, input_variables):
    """Execute the Concert graph snapshot accepted by the parent process."""
    process = multiprocessing.current_process()
    context = process.run_context
    queue = process.event_queue
    cancel_event = process.cancel_event
    run_id = context["runId"]
    concert_name = concert["name"]
    started = time.time()
    executor = None
    cache_store = None
    resource_store = ResourceStore(context["stageRoot"])
    stdout_router, stderr_router, original_stdout, original_stderr = (
        install_thread_local_output()
    )

    def emit(kind, **payload):
        queue.put({"kind": kind, "runId": run_id, **payload})

    try:
        params = runtime_params(
            concert.get("globalVariables") or [],
            concert.get("inputVariables") or [],
            input_variables or {},
        )
        concert_input_params = {
            str(item.get("name", "")).lstrip("$"): params[
                str(item.get("name", "")).lstrip("$")
            ]
            for item in concert.get("inputVariables") or []
            if isinstance(item, dict)
            and str(item.get("name", "")).lstrip("$") in params
        }
        all_nodes = [node for node in concert["nodes"] if node.get("type") != "text"]
        nodes = all_nodes
        node_ids = {node["id"] for node in nodes}
        edges = [edge for edge in concert["edges"] if edge.get("source") in node_ids and edge.get("target") in node_ids]
        if context["mode"] == "selected":
            nodes, edges = selected_concert_graph(nodes, edges, context.get("selected"))
        build_started = time.time()
        task_map = build_concert(
            nodes,
            edges,
            params=params,
            concert_root=context["playingRoot"],
            replay_root=context["replayRoot"],
            call_stack=[concert_name],
            call_ids=[concert["concertId"]],
            caller_input_params=concert_input_params,
            resource_store=resource_store,
            run_id=run_id,
        )
        if context["mode"] == "selected":
            selected = context.get("selected")
            if not selected or selected not in task_map:
                raise ValueError("selected node is required for selected mode")
            tasks = collect_dependencies(task_map[selected])
            runnable_ids = {task.id for task in tasks}
        else:
            runnable_ids = set(task_map)
        roots = [
            task for task in task_map.values()
            if task.id in runnable_ids and not task.internal_loop_task
            and not any(parent.id in runnable_ids and not parent.internal_loop_task for parent in task.parents)
        ]
        if not roots:
            raise ValueError("Concert has no executable root nodes")

        timestamp = context["runTimestamp"]
        replay_run = bool(context.get("replay"))
        save_replay = not replay_run
        save_cache = context["trigger"] == "manual"
        output_replay_id = _replay_id(timestamp) if save_replay else None
        replay_store = (
            ReplayDataStore(
                context["replayRoot"], concert_name=concert_name,
                replay_id=context.get("replayId") if replay_run else None,
                run_timestamp=timestamp, resource_store=resource_store,
            )
            if save_replay or replay_run else _NoReplayStore()
        )
        if save_replay:
            replay_store.save_metadata({
                "id": output_replay_id,
                "concertName": concert_name,
                "version": concert.get("version", ""),
                "createdAt": _now(),
                "trigger": context["trigger"],
                "params": concert_input_params,
                "inputParams": concert_input_params,
                "inputVariables": concert.get("inputVariables") or [],
                **(context.get("sourceMetadata") or {}),
            })
        cache_id = None
        if save_cache:
            cache_source_id = context.get("replayId") if replay_run else _replay_id(timestamp)
            cache_id = CacheDataStore._safe_name(run_id)
            cache_store = CacheDataStore(
                context["replayRoot"], concert_name=concert_name,
                source_replay_id=cache_source_id,
                run_id=run_id,
                metadata={
                    "runId": run_id,
                    "mode": context["mode"],
                    "replay": replay_run,
                    "status": "running",
                    **(context.get("sourceMetadata") or {}),
                },
            )
        replay_dir = os.path.join(context["replayRoot"], ReplayDataStore._safe_name(concert_name), ReplayDataStore._safe_replay_id(context.get("replayId") or output_replay_id or _replay_id(timestamp)))
        for task in task_map.values():
            if task.type == "opl":
                task.model_artifact_dirs = []
                if save_replay:
                    task.model_artifact_dirs.append(replay_dir)
                if cache_store:
                    task.model_artifact_dirs.append(cache_store.path)
                task.model_artifact_key = None

        timing = {"buildConcertMs": int((time.time() - build_started) * 1000), "executionMs": 0, "replaySaveMs": 0, "cacheSaveMs": 0}

        had_error = False

        def on_event(task, status, **event):
            nonlocal had_error
            if status == "error":
                had_error = True
            if event.get("duration_ms") is not None:
                timing["executionMs"] += event["duration_ms"]
            if event.get("cache_duration_ms") is not None:
                timing["cacheSaveMs"] += event["cache_duration_ms"]
            if event.get("replay_save_duration_ms") is not None:
                timing["replaySaveMs"] += event["replay_save_duration_ms"]
            emit(
                "node", nodeId=task.id, status=status,
                logs=event.get("logs", ""), error=event.get("error"),
                result=event.get("result"), durationMs=event.get("duration_ms"),
                cacheDurationMs=event.get("cache_duration_ms"),
                replaySaveDurationMs=event.get("replay_save_duration_ms"),
                loopIterations=task.loop_iterations,
            )

        executor = Executor(
            replay_store,
            cache_data_store=cache_store,
            replay=replay_run,
            on_event=on_event,
            runnable_task_ids=runnable_ids,
            cancel_event=cancel_event,
            stdout_router=stdout_router,
            stderr_router=stderr_router,
        )
        emit("started", pid=os.getpid(), cacheId=cache_id, replayId=output_replay_id)
        executor.start()
        for root in roots:
            executor.submit(root)
        executor.wait()
        status = "canceled" if cancel_event.is_set() else ("error" if had_error else "success")
        timing["totalElapsedMs"] = int((time.time() - started) * 1000)
        if cache_store:
            cache_store.finish(status, timing=timing)
        emit("finished", status=status, timing=timing, cacheId=cache_id, replayId=output_replay_id)
    except Exception as exc:
        if cache_store is not None:
            try:
                cache_store.finish(
                    "error",
                    timing={"totalElapsedMs": int((time.time() - started) * 1000)},
                )
            except Exception:
                pass
        emit("failed", error=str(exc), logs=traceback.format_exc(), timing={"totalElapsedMs": int((time.time() - started) * 1000)})
    finally:
        if executor is not None:
            executor.shutdown()
        resource_store.cleanup_run(run_id)
        close_all_pools()
        restore_thread_local_output(original_stdout, original_stderr)
