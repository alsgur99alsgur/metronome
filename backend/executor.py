from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
from io import StringIO
from queue import Queue
from threading import Event, Lock, Thread
import time
import traceback

import pandas as pd

from app_config import config_int
from replay_data_store import ReplayDataStore
from task import Task


class TaskTimeout(Exception):
    pass


REPLAY_TASK_TYPES = ("dbRead", "concertInput", "concert", "cacheRead", "fileRead")
SIDE_EFFECT_TASK_TYPES = ("dbWrite", "cacheWrite", "fileWrite")
LOOP_STOP_OPERATORS = {"==", "!=", ">=", ">", "<=", "<"}
EXECUTOR_WORKERS = config_int("executor", "workers")
EXECUTOR_TIMEOUT_SECONDS = config_int("executor", "timeoutSeconds")


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
    ):
        self.queue = Queue()
        self.replay_data_store = replay_data_store
        self.cache_data_store = cache_data_store
        self.replay = replay
        self.timeout = timeout if timeout is not None else EXECUTOR_TIMEOUT_SECONDS
        self.results = {}
        self.workers = workers if workers is not None else EXECUTOR_WORKERS
        self.on_event = on_event or (lambda *args, **kwargs: None)
        self.lock = Lock()
        self.skipped_task_ids = set()
        self.started = False
        self.runnable_task_ids = set(runnable_task_ids or [])
        self.cancel_event = cancel_event or Event()

    def start(self):
        if self.started:
            return
        self.started = True
        for worker_id in range(self.workers):
            Thread(target=self.worker, args=(worker_id,), daemon=True).start()

    def wait(self):
        self.queue.join()

    def submit(self, task):
        self.queue.put(task)

    def cancel(self):
        self.cancel_event.set()

    def execute_with_timeout(self, task, inputs):
        result_container = {}
        error_container = {}
        output = StringIO()
        done = Event()

        def run():
            try:
                with redirect_stdout(output), redirect_stderr(output):
                    result_container["result"] = task.execute(inputs)
            except Exception as exc:
                error_container["error"] = exc
                error_container["traceback"] = traceback.format_exc()
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
            max_grid_rows = 1000
            dtypes = {str(column): str(dtype) for column, dtype in result.dtypes.items()}
            return {
                "kind": "dataframe",
                "rows": int(len(result)),
                "columns": list(result.columns),
                "dtypes": dtypes,
                "preview": self._dataframe_records(result, 20),
                "data": self._dataframe_records(result, max_grid_rows),
                "dataLimit": max_grid_rows,
                "truncated": len(result) > max_grid_rows,
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

    def _build_task_inputs(self, task):
        inputs = []
        for parent in task.parents:
            value = self.results[parent.id]
            inputs.append(self._copy_input_value(value) if len(parent.children) > 1 else value)
        return inputs

    def _build_loop_seed_inputs(self, task):
        inputs = []
        dependency_parent_ids = task.loop_dependency_parent_ids or set()
        for parent in task.parents:
            if parent.id in dependency_parent_ids:
                continue
            value = self.results[parent.id]
            inputs.append(self._copy_input_value(value) if len(parent.children) > 1 else value)
        return inputs

    def _loop_key(self, loop_context):
        if not loop_context:
            return None
        return "_".join(str(item) for item in loop_context)

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
            return [df.iloc[[index]].reset_index(drop=True) for index in range(len(df))]
        if mode == "groupBy":
            columns = task.loop_data.get("groupByColumns") or []
            columns = self._loop_variable_value(task, columns)
            if isinstance(columns, str):
                columns = [item.strip() for item in columns.split(",") if item.strip()]
            if not columns:
                return [df]
            return [group.reset_index(drop=True) for _, group in df.groupby(columns, dropna=False, sort=False)]
        return [df]

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
            if self.replay and task.type in REPLAY_TASK_TYPES:
                result = self.replay_data_store.load_task_result(task, loop_key=loop_key)
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
                )
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
                result, logs = self.execute_with_timeout(task, inputs)
                if task.type in REPLAY_TASK_TYPES:
                    replay_save_start = time.time()
                    self.replay_data_store.save_task_result(task, result, loop_key=loop_key)
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
            )
            self.on_event(task, "error", logs=logs, error=str(exc), cache_duration_ms=cache_duration_ms)
            raise

    def _execute_loop_task(self, task, inputs, worker_id, loop_context=None):
        loop_out_start = time.time()
        loop_out_started_at_ms = int(loop_out_start * 1000)
        loop_context = loop_context or []
        loop_out_task = task.loop_out_task
        if loop_out_task is None:
            raise ValueError(f"Loop In has no Loop Out: {task.name}")

        outputs = []
        mode = task.loop_data.get("iterationMode") or task.loop_data.get("mode") or "allRows"
        if mode == "allRows":
            seed_df = inputs[0] if inputs and isinstance(inputs[0], pd.DataFrame) else pd.DataFrame()
            planned_iterations = [seed_df]
            max_iterations = self._loop_max_iterations(
                loop_out_task,
                1000 if self._loop_has_stop_condition(loop_out_task) else 1,
            )
        else:
            planned_iterations = self._loop_iterations(task, inputs)
            max_iterations = len(planned_iterations)

        logs = [f"LOOP {task.name}: {max_iterations} max iterations"]
        index = 1
        completed_iterations = 0
        next_iteration_df = planned_iterations[0] if planned_iterations else pd.DataFrame()
        last_result = pd.DataFrame()
        while index <= max_iterations:
            if self.cancel_event.is_set():
                break
            current_context = [*loop_context, index]
            with self.lock:
                self.results[task.id] = next_iteration_df
            executed = {task.id}
            self._execute_loop_body_task(loop_out_task, executed, current_context, worker_id)
            completed_iterations += 1
            result = self.results.get(loop_out_task.id)
            if isinstance(result, pd.DataFrame):
                last_result = result
                if mode != "allRows":
                    outputs.append(result)
            logs.append(f"iteration {self._loop_key(current_context)}")
            if mode == "allRows" and self._loop_should_stop(loop_out_task, index, result):
                break
            index += 1
            if mode == "allRows":
                next_iteration_df = result if isinstance(result, pd.DataFrame) else next_iteration_df
            elif index <= len(planned_iterations):
                next_iteration_df = planned_iterations[index - 1]
            else:
                break

        if mode == "allRows":
            final_result = last_result
        elif outputs:
            final_result = pd.concat(outputs, ignore_index=True)
        else:
            final_result = pd.DataFrame()

        loop_out_finished_at_ms = int(time.time() * 1000)
        loop_out_duration_ms = max(
            0,
            loop_out_finished_at_ms - loop_out_started_at_ms,
        )

        replay_save_duration_ms = 0
        if not self.replay:
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
        )
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
            task: Task = self.queue.get()

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

                if self.replay and task.type in REPLAY_TASK_TYPES:
                    result = self.replay_data_store.load_task_result(task)
                    logs = f"Loaded replay data for {task.name}."
                elif self.replay and task.type in SIDE_EFFECT_TASK_TYPES:
                    result = self.results.get(task.parents[0].id) if task.parents else None
                    with self.lock:
                        self.results[task.id] = result
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
                    if task.type in REPLAY_TASK_TYPES:
                        replay_save_start = time.time()
                        self.replay_data_store.save_task_result(task, result)
                        replay_save_duration_ms = int((time.time() - replay_save_start) * 1000)

                if self.cancel_event.is_set():
                    duration_ms = int((time.time() - start) * 1000) - replay_save_duration_ms
                    with self.lock:
                        self.results[task.id] = result
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

                with self.lock:
                    self.results[task.id] = result

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
