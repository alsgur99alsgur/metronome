from concurrent.futures import ThreadPoolExecutor, as_completed
from copy import deepcopy
from queue import Queue
from threading import BoundedSemaphore, Event, Lock, Thread
import os
import tempfile
import time
import traceback

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from app_config import config_int
from replay_data_store import ReplayDataStore
from task import Task
from thread_local_output import CappedTextBuffer, capture_thread_output


class TaskTimeout(Exception):
    pass


REPLAY_TASK_TYPES = ("dbRead", "concertInput", "concert", "cacheRead", "opl")
SIDE_EFFECT_TASK_TYPES = ("dbWrite", "cacheWrite")
LOOP_STOP_OPERATORS = {"==", "!=", ">=", ">", "<=", "<"}
_WORKER_STOP = object()


class Executor:
    def __init__(
        self,
        replay_data_store: ReplayDataStore,
        cache_data_store=None,
        replay=False,
        workers=None,
        timeout=None,
        on_event=None,
        runnable_task_ids=None,
        cancel_event=None,
        save_loop_snapshots=True,
        capture_task_output=True,
        loop_thread_semaphore=None,
        stdout_router=None,
        stderr_router=None,
        node_log_limit_bytes=None,
    ):
        self.queue = Queue()
        self.replay_data_store = replay_data_store
        self.cache_data_store = cache_data_store
        self.replay = replay
        self.timeout = timeout if timeout is not None else config_int("executor", "timeoutSeconds")
        self.results = {}
        self.result_consumers = {}
        self.workers = workers if workers is not None else config_int("executor", "workers")
        self.on_event = on_event or (lambda *args, **kwargs: None)
        self.lock = Lock()
        self.skipped_task_ids = set()
        self.started = False
        self.runnable_task_ids = set(runnable_task_ids or [])
        self.cancel_event = cancel_event or Event()
        self.worker_threads = []
        self.save_loop_snapshots = save_loop_snapshots
        self.capture_task_output = capture_task_output
        self.stdout_router = stdout_router
        self.stderr_router = stderr_router
        self.node_log_limit_bytes = (
            node_log_limit_bytes
            if node_log_limit_bytes is not None
            else config_int("executor", "nodeLogLimitKb") * 1024
        )
        if self.node_log_limit_bytes < 1024:
            raise ValueError("executor.nodeLogLimitKb must be at least 1.")
        self.loop_thread_semaphore = loop_thread_semaphore or BoundedSemaphore(
            max(1, self.workers)
        )

    def start(self):
        if self.started:
            return
        self.started = True
        for worker_id in range(self.workers):
            thread = Thread(
                target=self.worker,
                args=(worker_id,),
                name=f"concert-worker-{worker_id}",
                daemon=True,
            )
            thread.start()
            self.worker_threads.append(thread)

    def wait(self):
        self.queue.join()

    def submit(self, task):
        self.queue.put(task)

    def cancel(self):
        self.cancel_event.set()

    def shutdown(self, wait=True):
        if not self.started:
            return
        for _ in self.worker_threads:
            self.queue.put(_WORKER_STOP)
        if wait:
            for thread in self.worker_threads:
                thread.join()
        self.worker_threads.clear()
        self.results.clear()
        self.result_consumers.clear()
        self.skipped_task_ids.clear()
        self.on_event = lambda *args, **kwargs: None
        self.cache_data_store = None
        self.replay_data_store = None
        self.started = False

    def execute_with_timeout(self, task, inputs):
        result_container = {}
        error_container = {}
        output = CappedTextBuffer(self.node_log_limit_bytes)
        done = Event()

        def run():
            try:
                if self.capture_task_output:
                    if self.stdout_router is None or self.stderr_router is None:
                        raise RuntimeError("Thread-local output routers are not installed.")
                    with capture_thread_output(
                        self.stdout_router,
                        self.stderr_router,
                        output,
                    ):
                        result_container["result"] = task.execute(inputs)
                else:
                    result_container["result"] = task.execute(inputs)
            except Exception as exc:
                error_container["error"] = exc
                output.write(traceback.format_exc())
                error_container["traceback"] = output.getvalue()
            finally:
                done.set()

        thread = Thread(target=run, daemon=True)
        thread.start()
        thread.join(self.timeout)

        if not done.is_set():
            raise TaskTimeout(f"{task.name} timeout ({self.timeout}s)")
        if "error" in error_container:
            error = error_container["error"]
            error.__captured_traceback__ = error_container.get("traceback", "")
            raise error

        return result_container.get("result"), output.getvalue()

    def _dataframe_records(self, df, limit):
        data = df.head(limit).astype(object)
        data = data.where(pd.notnull(data), None)
        data = data.replace({float("inf"): None, float("-inf"): None})
        return data.to_dict(orient="records")

    def _summarize_result(self, result):
        if isinstance(result, pd.DataFrame):
            return {
                "kind": "dataframe",
                "rows": int(len(result)),
                "columns": [str(column) for column in result.columns],
                "dtypes": {
                    str(column): str(dtype)
                    for column, dtype in zip(result.columns, result.dtypes)
                },
            }
        if result is None:
            return {"kind": "none"}
        return {"kind": type(result).__name__, "repr": repr(result)[:1000]}

    def _copy_input_value(self, value):
        if isinstance(value, pd.DataFrame):
            return value.copy(deep=True)
        try:
            return deepcopy(value)
        except Exception:
            return value

    def _runnable_children(self, task):
        return [
            child
            for child in task.children
            if not child.internal_loop_task
            and (
                not self.runnable_task_ids
                or child.id in self.runnable_task_ids
            )
        ]

    @staticmethod
    def _requires_loop_result_retention(task):
        return bool(
            task.internal_loop_task
            or task.loop_out_task is not None
            or task.loop_owner_id is not None
            or any(child.internal_loop_task for child in task.children)
        )

    def _store_result(self, task, result):
        with self.lock:
            self.results[task.id] = result
            if self._requires_loop_result_retention(task):
                self.result_consumers.pop(task.id, None)
                return
            consumer_count = len(self._runnable_children(task))
            if consumer_count:
                self.result_consumers[task.id] = consumer_count
            else:
                self.results.pop(task.id, None)
                self.result_consumers.pop(task.id, None)

    def _claim_parent_result(self, parent):
        with self.lock:
            value = self.results[parent.id]
            remaining = self.result_consumers.get(parent.id)
            if remaining is None:
                return value
            if remaining > 1:
                claimed = self._copy_input_value(value)
                self.result_consumers[parent.id] = remaining - 1
                return claimed
            self.result_consumers.pop(parent.id, None)
            self.results.pop(parent.id, None)
            return value

    def _build_task_inputs(self, task):
        values = [self._claim_parent_result(parent) for parent in task.parents]
        if task.internal_loop_task:
            return [self._copy_input_value(value) for value in values]
        return values

    def _build_loop_seed_inputs(self, task):
        inputs = []
        dependency_parent_ids = task.loop_dependency_parent_ids or set()
        for parent in task.parents:
            if parent.id in dependency_parent_ids:
                continue
            inputs.append(self._claim_parent_result(parent))
        return inputs

    def _loop_key(self, loop_context):
        if not loop_context:
            return None
        return "_".join(str(item) for item in loop_context)

    @staticmethod
    def _is_replay_task(task):
        return task.type in REPLAY_TASK_TYPES and not (
            task.type == "cacheRead" and task.cache_scope != "stage"
        )

    def _loop_variable_value(self, task, value):
        if not isinstance(value, str):
            return value
        text = value.strip()
        if not text.startswith("$") or not text[1:].isidentifier():
            return value
        name = text[1:]
        if name not in task.loop_params:
            raise KeyError(f"Loop variable not found: ${name}")
        return task.loop_params[name]

    def _loop_iterations(self, task, inputs):
        mode = task.loop_data.get("iterationMode") or task.loop_data.get("mode") or "allRows"
        if inputs and isinstance(inputs[0], pd.DataFrame):
            df = inputs[0]
        else:
            df = pd.DataFrame()

        if mode == "eachRow":
            return (
                (
                    df.iloc[[index]].reset_index(drop=True)
                    for index in range(len(df))
                ),
                len(df),
            )
        if mode == "groupBy":
            columns = task.loop_data.get("groupByColumns") or []
            columns = self._loop_variable_value(task, columns)
            if isinstance(columns, str):
                columns = [item.strip() for item in columns.split(",") if item.strip()]
            if not columns:
                return iter((df,)), 1
            groups = df.groupby(columns, dropna=False, sort=False)
            return (
                (group.reset_index(drop=True) for _, group in groups),
                groups.ngroups,
            )
        return iter((df,)), 1

    @staticmethod
    def _append_loop_output(writer, path, result, expected_schema):
        table = pa.Table.from_pandas(result, preserve_index=False)
        if expected_schema is not None and table.schema != expected_schema:
            raise ValueError(
                "Loop output columns and dtypes must remain the same for every iteration."
            )
        if writer is None:
            writer = pq.ParquetWriter(path, table.schema)
        writer.write_table(table)
        return writer, table.schema

    def _coerce_stop_value(self, value, sample):
        if sample is None:
            return value
        try:
            if isinstance(sample, bool):
                return str(value).lower() in ("1", "true", "yes", "y")
            if pd.api.types.is_integer(sample):
                return int(value)
            if pd.api.types.is_float(sample):
                return float(value)
        except Exception:
            return value
        return value

    def _stop_condition_matches(self, actual, operator, expected):
        expected = self._coerce_stop_value(expected, actual)
        if operator == "!=":
            return actual != expected
        if operator == ">":
            return actual > expected
        if operator == ">=":
            return actual >= expected
        if operator == "<":
            return actual < expected
        if operator == "<=":
            return actual <= expected
        if operator == "==":
            return actual == expected
        raise ValueError(f"Unsupported Loop Out stop operator: {operator}")

    def _loop_should_stop(self, loop_out_task, iteration_index, result):
        max_iterations = loop_out_task.loop_data.get("maxIterations")
        max_iterations = self._loop_variable_value(loop_out_task, max_iterations)
        if max_iterations not in (None, ""):
            try:
                max_iteration_value = int(max_iterations)
                if max_iteration_value > 0 and iteration_index >= max_iteration_value:
                    return True
            except ValueError:
                pass

        conditions = loop_out_task.loop_data.get("stopConditions") or []
        if not conditions:
            return False

        if not isinstance(conditions, list):
            raise ValueError("Loop Out stopConditions must be a list.")
        if not isinstance(result, pd.DataFrame):
            raise ValueError("Loop Out stop conditions require a DataFrame result.")

        for condition in conditions:
            column = condition.get("column")
            operator = condition.get("operator") or "=="
            if not column:
                raise ValueError("Loop Out stop condition has no column.")
            if column not in result.columns:
                raise ValueError(f"Loop Out stop column is missing from result: {column}")
            if operator not in LOOP_STOP_OPERATORS:
                raise ValueError(f"Unsupported Loop Out stop operator: {operator}")

        if result.empty:
            return False

        # A row stops the loop only when every configured column condition matches it.
        for _index, row in result.iterrows():
            if all(
                self._stop_condition_matches(
                    row[condition.get("column")],
                    condition.get("operator") or "==",
                    self._loop_variable_value(
                        loop_out_task,
                        condition.get("value"),
                    ),
                )
                for condition in conditions
            ):
                return True
        return False

    def _loop_max_iterations(self, loop_out_task, default_value):
        max_iterations = loop_out_task.loop_data.get("maxIterations")
        max_iterations = self._loop_variable_value(loop_out_task, max_iterations)
        if max_iterations in (None, ""):
            return default_value
        try:
            max_iteration_value = int(max_iterations)
            if max_iteration_value <= 0:
                return default_value
            return max_iteration_value
        except ValueError:
            return default_value

    def _loop_has_stop_condition(self, loop_out_task):
        return bool(loop_out_task.loop_data.get("stopConditions"))

    def _execute_loop_body_task(self, task, executed, loop_context, worker_id):
        if task.id in executed:
            return self.results.get(task.id)
        for parent in task.parents:
            if parent.internal_loop_task and parent.loop_owner_id == task.loop_owner_id:
                self._execute_loop_body_task(parent, executed, loop_context, worker_id)

        self.on_event(task, "running")
        start = time.time()
        started_at_ms = int(start * 1000)
        replay_save_duration_ms = 0
        loop_key = self._loop_key(loop_context)
        try:
            if self.replay and self._is_replay_task(task):
                result = self.replay_data_store.load_task_result(task)
                logs = f"Loaded replay data for {task.name}."
            elif self.replay and task.type in SIDE_EFFECT_TASK_TYPES:
                result = self.results.get(task.parents[0].id) if task.parents else None
                logs = f"Skipped side-effect task {task.name} in replay mode."
                duration_ms = int((time.time() - start) * 1000)
                with self.lock:
                    self.results[task.id] = result
                cache_duration_ms = self._save_cache_event(
                    task,
                    "skipped",
                    result=result,
                    duration_ms=duration_ms,
                    logs=logs,
                    worker_id=worker_id,
                    started_at_ms=started_at_ms,
                    finished_at_ms=int(time.time() * 1000),
                ) if self.save_loop_snapshots else 0
                self.on_event(
                    task,
                    "skipped",
                    logs=logs,
                    duration_ms=duration_ms,
                    result=self._summarize_result(result),
                    cache_duration_ms=cache_duration_ms,
                )
                executed.add(task.id)
                return result
            elif task.type == "loopIn":
                inputs = self._build_loop_seed_inputs(task)
                result, logs = self._execute_loop_task(task, inputs, worker_id, loop_context)
            else:
                inputs = self._build_task_inputs(task)
                if task.type == "opl":
                    task.model_artifact_key = None
                with self.loop_thread_semaphore:
                    result, logs = self.execute_with_timeout(task, inputs)
                if self.save_loop_snapshots and self._is_replay_task(task):
                    replay_save_start = time.time()
                    self.replay_data_store.save_task_result(task, result)
                    replay_save_duration_ms = int((time.time() - replay_save_start) * 1000)

            duration_ms = int((time.time() - start) * 1000) - replay_save_duration_ms
            with self.lock:
                self.results[task.id] = result
            cache_duration_ms = self._save_cache_event(
                task,
                "success",
                result=result,
                duration_ms=duration_ms,
                logs=logs,
                worker_id=worker_id,
                started_at_ms=started_at_ms,
                finished_at_ms=int(time.time() * 1000),
            ) if self.save_loop_snapshots else 0
            self.on_event(
                task,
                "success",
                logs=logs,
                duration_ms=duration_ms,
                result=self._summarize_result(result),
                cache_duration_ms=cache_duration_ms,
                replay_save_duration_ms=replay_save_duration_ms,
            )
            executed.add(task.id)
            return result
        except Exception as exc:
            logs = getattr(exc, "__captured_traceback__", traceback.format_exc())
            cache_duration_ms = self._save_cache_event(
                task,
                "error",
                logs=logs,
                error=str(exc),
                worker_id=worker_id,
                started_at_ms=started_at_ms,
                finished_at_ms=int(time.time() * 1000),
            ) if self.save_loop_snapshots else 0
            self.on_event(task, "error", logs=logs, error=str(exc), cache_duration_ms=cache_duration_ms)
            raise

    def _execute_loop_iteration(self, task, iteration_df, loop_context, worker_id):
        iteration_executor = Executor(
            self.replay_data_store,
            cache_data_store=self.cache_data_store,
            replay=self.replay,
            workers=self.workers,
            timeout=self.timeout,
            on_event=self.on_event,
            runnable_task_ids=self.runnable_task_ids,
            cancel_event=self.cancel_event,
            save_loop_snapshots=False,
            capture_task_output=self.capture_task_output,
            loop_thread_semaphore=self.loop_thread_semaphore,
            stdout_router=self.stdout_router,
            stderr_router=self.stderr_router,
            node_log_limit_bytes=self.node_log_limit_bytes,
        )
        with self.lock:
            for body_task in task.loop_body_tasks:
                for parent in body_task.parents:
                    if not parent.internal_loop_task and parent.id in self.results:
                        iteration_executor.results[parent.id] = self._copy_input_value(
                            self.results[parent.id]
                        )
        iteration_executor.results[task.id] = self._copy_input_value(iteration_df)
        completed = {task.id}
        pending = {body_task.id: body_task for body_task in task.loop_body_tasks}

        with ThreadPoolExecutor(
            max_workers=max(1, self.workers),
            thread_name_prefix=f"loop-{task.id}",
        ) as pool:
            while pending:
                if self.cancel_event.is_set():
                    break
                ready = []
                for body_task in pending.values():
                    internal_parents = [
                        parent.id
                        for parent in body_task.parents
                        if parent.internal_loop_task
                        and parent.loop_owner_id == body_task.loop_owner_id
                    ]
                    if all(parent_id in completed for parent_id in internal_parents):
                        ready.append(body_task)
                if not ready:
                    unresolved = ", ".join(sorted(pending))
                    raise ValueError(f"Loop body has unresolved dependencies: {unresolved}")
                futures = {
                    pool.submit(
                        iteration_executor._execute_loop_body_task,
                        body_task,
                        completed,
                        loop_context,
                        worker_id,
                    ): body_task
                    for body_task in ready
                }
                for future in as_completed(futures):
                    body_task = futures[future]
                    future.result()
                    completed.add(body_task.id)
                    pending.pop(body_task.id, None)

        return (
            iteration_executor.results.get(task.loop_out_task.id, pd.DataFrame()),
            iteration_executor.results,
        )

    def _save_last_loop_snapshot(self, task, snapshot, worker_id, parent_result):
        self._save_cache_event(
            task,
            "success",
            result=parent_result,
            logs="Saved the Loop In parent result from the outermost loop's last iteration.",
            worker_id=worker_id,
        )
        body_tasks = []
        pending = list(task.loop_body_tasks)
        seen = set()
        while pending:
            body_task = pending.pop()
            if body_task.id in seen:
                continue
            seen.add(body_task.id)
            body_tasks.append(body_task)
            pending.extend(body_task.loop_body_tasks)
        for body_task in body_tasks:
            if body_task.id == task.loop_out_task.id or body_task.id not in snapshot:
                continue
            result = snapshot[body_task.id]
            if not self.replay and self._is_replay_task(body_task):
                self.replay_data_store.save_task_result(body_task, result)
            self._save_cache_event(
                body_task,
                "success",
                result=result,
                logs="Saved from the outermost loop's last iteration.",
                worker_id=worker_id,
            )

    def _execute_loop_task(self, task, inputs, worker_id, loop_context=None):
        loop_out_start = time.time()
        loop_out_started_at_ms = int(loop_out_start * 1000)
        loop_context = loop_context or []
        loop_out_task = task.loop_out_task
        if loop_out_task is None:
            raise ValueError(f"Loop In has no Loop Out: {task.name}")
        if len(inputs) != 1:
            raise ValueError(
                f"Loop In requires exactly one parent result: {task.name} ({len(inputs)} received)"
            )
        loop_parent_result = self._copy_input_value(inputs[0])

        mode = task.loop_data.get("iterationMode") or task.loop_data.get("mode") or "allRows"
        iteration_iterator = None
        if mode == "allRows":
            seed_df = inputs[0] if inputs and isinstance(inputs[0], pd.DataFrame) else pd.DataFrame()
            max_iterations = self._loop_max_iterations(
                loop_out_task,
                1000 if self._loop_has_stop_condition(loop_out_task) else 1,
            )
            next_iteration_df = seed_df
        else:
            iteration_iterator, max_iterations = self._loop_iterations(task, inputs)
            next_iteration_df = next(iteration_iterator, None)

        logs = [f"LOOP {task.name}: {max_iterations} max iterations"]
        index = 1
        completed_iterations = 0
        last_result = pd.DataFrame()
        output_writer = None
        output_schema = None
        output_path = None
        if mode != "allRows":
            fd, output_path = tempfile.mkstemp(prefix="metronome-loop-", suffix=".parquet")
            os.close(fd)
        last_snapshot = None
        try:
            if mode == "allRows":
                while index <= max_iterations and next_iteration_df is not None:
                    if self.cancel_event.is_set():
                        break
                    current_context = [*loop_context, index]
                    result, last_snapshot = self._execute_loop_iteration(
                        task,
                        next_iteration_df,
                        current_context,
                        worker_id,
                    )
                    completed_iterations += 1
                    if isinstance(result, pd.DataFrame):
                        last_result = result
                    logs.append(f"iteration {self._loop_key(current_context)}")
                    if self._loop_should_stop(loop_out_task, index, result):
                        break
                    index += 1
                    next_iteration_df = (
                        result
                        if isinstance(result, pd.DataFrame)
                        else next_iteration_df
                    )
            else:
                with ThreadPoolExecutor(
                    max_workers=max(1, self.workers),
                    thread_name_prefix=f"loop-iterations-{task.id}",
                ) as pool:
                    while index <= max_iterations and next_iteration_df is not None:
                        batch = []
                        while (
                            len(batch) < max(1, self.workers)
                            and index <= max_iterations
                            and next_iteration_df is not None
                        ):
                            batch.append((index, self._copy_input_value(next_iteration_df)))
                            index += 1
                            next_iteration_df = next(iteration_iterator, None)
                        futures = {
                            pool.submit(
                                self._execute_loop_iteration,
                                task,
                                iteration_df,
                                [*loop_context, iteration_index],
                                worker_id,
                            ): iteration_index
                            for iteration_index, iteration_df in batch
                        }
                        iteration_results = {
                            futures[future]: future.result()
                            for future in as_completed(futures)
                        }
                        for iteration_index, _ in batch:
                            result, snapshot = iteration_results[iteration_index]
                            completed_iterations += 1
                            if isinstance(result, pd.DataFrame):
                                last_result = result
                                output_writer, output_schema = self._append_loop_output(
                                    output_writer,
                                    output_path,
                                    result,
                                    output_schema,
                                )
                            last_snapshot = snapshot
                            logs.append(
                                f"iteration {self._loop_key([*loop_context, iteration_index])}"
                            )

            if mode == "allRows":
                final_result = last_result
            elif output_writer is not None:
                output_writer.close()
                output_writer = None
                final_result = pd.read_parquet(output_path)
            else:
                final_result = pd.DataFrame()
        finally:
            if output_writer is not None:
                output_writer.close()
            if output_path and os.path.exists(output_path):
                os.unlink(output_path)

        loop_out_finished_at_ms = int(time.time() * 1000)
        loop_out_duration_ms = max(
            0,
            loop_out_finished_at_ms - loop_out_started_at_ms,
        )

        replay_save_duration_ms = 0
        if last_snapshot is not None:
            with self.lock:
                self.results.update(last_snapshot)
                self.results[task.id] = loop_parent_result
        if self.save_loop_snapshots and last_snapshot is not None:
            self._save_last_loop_snapshot(
                task,
                last_snapshot,
                worker_id,
                loop_parent_result,
            )
        if self.save_loop_snapshots and not self.replay:
            replay_save_start = time.time()
            self.replay_data_store.save_task_result(loop_out_task, final_result)
            replay_save_duration_ms = int((time.time() - replay_save_start) * 1000)

        with self.lock:
            self.results[loop_out_task.id] = final_result
        task.loop_iterations = completed_iterations
        loop_out_task.loop_iterations = completed_iterations
        cache_duration_ms = self._save_cache_event(
            loop_out_task,
            "success",
            result=final_result,
            duration_ms=loop_out_duration_ms,
            logs="\n".join(logs),
            worker_id=worker_id,
            started_at_ms=loop_out_started_at_ms,
            finished_at_ms=loop_out_finished_at_ms,
        ) if self.save_loop_snapshots else 0
        self.on_event(
            loop_out_task,
            "success",
            logs="\n".join(logs),
            duration_ms=loop_out_duration_ms,
            result=self._summarize_result(final_result),
            cache_duration_ms=cache_duration_ms,
            replay_save_duration_ms=replay_save_duration_ms,
        )
        return final_result, "\n".join(logs)

    def _save_cache_event(
        self,
        task,
        status,
        result=None,
        duration_ms=None,
        logs="",
        error=None,
        worker_id=None,
        started_at_ms=None,
        finished_at_ms=None,
    ):
        if not self.cache_data_store:
            return 0
        start = time.time()
        self.cache_data_store.save_task_event(
            task,
            status,
            result=result,
            duration_ms=duration_ms,
            logs=logs,
            error=error,
            worker_id=worker_id,
            started_at_ms=started_at_ms,
            finished_at_ms=finished_at_ms,
        )
        return int((time.time() - start) * 1000)

    def _mark_children_skipped(self, task, reason):
        for child in task.children:
            if self.runnable_task_ids and child.id not in self.runnable_task_ids:
                continue
            with self.lock:
                if child.id in self.skipped_task_ids:
                    continue
                self.skipped_task_ids.add(child.id)
            cache_duration_ms = self._save_cache_event(
                child,
                "skipped",
                error=f"Skipped because parent {task.name} failed: {reason}",
            )
            self.on_event(
                child,
                "skipped",
                logs="",
                error=f"Skipped because parent {task.name} failed: {reason}",
                cache_duration_ms=cache_duration_ms,
            )
            self._mark_children_skipped(child, reason)

    def worker(self, worker_id):
        while True:
            task = self.queue.get()
            if task is _WORKER_STOP:
                self.queue.task_done()
                return

            try:
                started_at_ms = None
                with self.lock:
                    is_skipped = task.id in self.skipped_task_ids
                if is_skipped:
                    continue

                if self.cancel_event.is_set():
                    cache_duration_ms = self._save_cache_event(task, "skipped", error="Run canceled.")
                    self.on_event(task, "skipped", logs="", error="Run canceled.", cache_duration_ms=cache_duration_ms)
                    self._mark_children_skipped(task, "Run canceled.")
                    continue

                self.on_event(task, "running")
                start = time.time()
                started_at_ms = int(start * 1000)
                replay_save_duration_ms = 0

                if self.replay and self._is_replay_task(task):
                    result = self.replay_data_store.load_task_result(task)
                    logs = f"Loaded replay data for {task.name}."
                elif self.replay and task.type in SIDE_EFFECT_TASK_TYPES:
                    inputs = self._build_task_inputs(task)
                    result = inputs[0] if inputs else None
                    self._store_result(task, result)
                    duration_ms = int((time.time() - start) * 1000)
                    cache_duration_ms = self._save_cache_event(
                        task,
                        "skipped",
                        result=result,
                        duration_ms=duration_ms,
                        logs=f"Skipped side-effect task {task.name} in replay mode.",
                        worker_id=worker_id,
                        started_at_ms=started_at_ms,
                        finished_at_ms=int(time.time() * 1000),
                    )
                    self.on_event(
                        task,
                        "skipped",
                        logs=f"Skipped side-effect task {task.name} in replay mode.",
                        duration_ms=duration_ms,
                        result=self._summarize_result(result),
                        cache_duration_ms=cache_duration_ms,
                    )
                    for child in task.children:
                        if child.internal_loop_task:
                            continue
                        if self.runnable_task_ids and child.id not in self.runnable_task_ids:
                            continue
                        with self.lock:
                            if child.id in self.skipped_task_ids:
                                continue
                        child.remaining -= 1
                        if child.remaining == 0:
                            self.queue.put(child)
                    continue
                elif task.type == "loopIn":
                    inputs = self._build_loop_seed_inputs(task)
                    result, logs = self._execute_loop_task(task, inputs, worker_id, [])
                    duration_ms = int((time.time() - start) * 1000)
                else:
                    inputs = self._build_task_inputs(task)
                    result, logs = self.execute_with_timeout(task, inputs)
                    duration_ms = int((time.time() - start) * 1000)
                    if self._is_replay_task(task):
                        replay_save_start = time.time()
                        self.replay_data_store.save_task_result(task, result)
                        replay_save_duration_ms = int((time.time() - replay_save_start) * 1000)

                if self.cancel_event.is_set():
                    duration_ms = int((time.time() - start) * 1000) - replay_save_duration_ms
                    self._store_result(task, result)
                    cache_duration_ms = self._save_cache_event(
                        task,
                        "skipped",
                        result=result,
                        duration_ms=duration_ms,
                        logs=logs,
                        error="Run canceled.",
                        worker_id=worker_id,
                        started_at_ms=started_at_ms,
                        finished_at_ms=int(time.time() * 1000),
                    )
                    self.on_event(
                        task,
                        "skipped",
                        logs=logs,
                        error="Run canceled.",
                        duration_ms=duration_ms,
                        result=self._summarize_result(result),
                        cache_duration_ms=cache_duration_ms,
                        replay_save_duration_ms=replay_save_duration_ms,
                    )
                    self._mark_children_skipped(task, "Run canceled.")
                    continue

                self._store_result(task, result)

                duration_ms = int((time.time() - start) * 1000) - replay_save_duration_ms
                cache_duration_ms = self._save_cache_event(
                    task,
                    "success",
                    result=result,
                    duration_ms=duration_ms,
                    logs=logs,
                    worker_id=worker_id,
                    started_at_ms=started_at_ms,
                    finished_at_ms=int(time.time() * 1000),
                )
                self.on_event(
                    task,
                    "success",
                    logs=logs,
                    duration_ms=duration_ms,
                    result=self._summarize_result(result),
                    cache_duration_ms=cache_duration_ms,
                    replay_save_duration_ms=replay_save_duration_ms,
                )

                for child in task.children:
                    if child.internal_loop_task:
                        continue
                    if self.runnable_task_ids and child.id not in self.runnable_task_ids:
                        continue
                    with self.lock:
                        if child.id in self.skipped_task_ids:
                            continue
                    child.remaining -= 1
                    if child.remaining == 0:
                        self.queue.put(child)

            except Exception as exc:
                logs = getattr(exc, "__captured_traceback__", traceback.format_exc())
                cache_duration_ms = self._save_cache_event(
                    task,
                    "error",
                    logs=logs,
                    error=str(exc),
                    worker_id=worker_id,
                    started_at_ms=started_at_ms,
                    finished_at_ms=int(time.time() * 1000) if started_at_ms is not None else None,
                )
                self.on_event(task, "error", logs=logs, error=str(exc), cache_duration_ms=cache_duration_ms)
                self._mark_children_skipped(task, str(exc))
            finally:
                self.queue.task_done()
