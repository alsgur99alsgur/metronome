from datetime import datetime
import json
import os
import re
import shutil
from threading import Lock

import duckdb
import pandas as pd

from atomic_file import atomic_write_json, atomic_write_parquet
from json_serialization import json_default


class CacheDataStore:
    def __init__(
        self,
        replay_root="./replay",
        concert_name="untitled_concert",
        source_replay_id=None,
        run_id=None,
        metadata=None,
    ):
        self.replay_root = replay_root
        self.concert_name = self._safe_name(concert_name)
        self.source_replay_id = self._safe_replay_id(source_replay_id)
        self.cache_id = self._safe_name(run_id)
        self.path = os.path.join(
            self.replay_root,
            self.concert_name,
            self.source_replay_id,
            "cache",
            self.cache_id,
        )
        os.makedirs(self.path, exist_ok=True)
        self.metadata_path = os.path.join(self.path, "metadata.json")
        self.lock = Lock()
        self.metadata = {
            "id": self.cache_id,
            "runId": self.cache_id,
            "concertName": self.concert_name,
            "sourceReplayId": self.source_replay_id,
            "createdAt": datetime.utcnow().isoformat() + "Z",
            "nodes": {},
            **(metadata or {}),
        }
        self._write_metadata()

    @staticmethod
    def _safe_name(name):
        safe = re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(name or "")).strip("_")
        if not safe:
            raise ValueError("Cache path name is required.")
        return safe

    @classmethod
    def _safe_replay_id(cls, name):
        return cls._safe_name(str(name or "").replace("\\", "/").strip("/"))

    @classmethod
    def _load_metadata(cls, path):
        metadata_path = os.path.join(path, "metadata.json")
        if not os.path.exists(metadata_path):
            return {}
        with open(metadata_path, "r", encoding="utf-8") as file:
            return json.load(file)

    def _write_metadata(self):
        atomic_write_json(self.metadata_path, self.metadata, default=json_default)

    def finish(self, status, finished_at=None, timing=None):
        with self.lock:
            self.metadata["status"] = status
            self.metadata["finishedAt"] = finished_at or datetime.utcnow().isoformat() + "Z"
            self.metadata["updatedAt"] = datetime.utcnow().isoformat() + "Z"
            if timing is not None:
                self.metadata["timing"] = timing
            self._write_metadata()

    @staticmethod
    def _dataframe_summary(df):
        return {
            "kind": "dataframe",
            "rows": int(len(df)),
            "columns": list(df.columns),
            "dtypes": {str(column): str(dtype) for column, dtype in df.dtypes.items()},
        }

    def save_task_event(
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
        node = {
            "id": task.id,
            "name": task.name,
            "type": task.type,
            "status": status,
            "logs": logs or "",
            "error": error,
            "durationMs": duration_ms,
            "updatedAt": datetime.utcnow().isoformat() + "Z",
        }
        if worker_id is not None:
            node["workerId"] = worker_id
        if started_at_ms is not None:
            node["startedAtMs"] = started_at_ms
        if finished_at_ms is not None:
            node["finishedAtMs"] = finished_at_ms
        if task.loop_iterations is not None:
            node["loopIterations"] = task.loop_iterations

        if task.type == "cacheRead" and task.cache_scope != "stage":
            node["kind"] = "none"
        elif isinstance(result, pd.DataFrame):
            file_name = f"{self._safe_name(task.id)}.parquet"
            atomic_write_parquet(result, os.path.join(self.path, file_name))
            node.update(self._dataframe_summary(result))
            node["file"] = file_name
        elif result is None:
            node["kind"] = "none"
        else:
            node["kind"] = type(result).__name__
            node["repr"] = repr(result)[:1000]

        with self.lock:
            self.metadata.setdefault("nodes", {})[task.id] = node
            self.metadata["updatedAt"] = datetime.utcnow().isoformat() + "Z"
            self._write_metadata()

    @classmethod
    def _cache_paths(cls, replay_root="./replay", concert_name=None):
        if not os.path.isdir(replay_root):
            return []
        paths = []
        concert_names = (
            [cls._safe_name(concert_name)]
            if concert_name
            else sorted(os.listdir(replay_root))
        )
        for current_concert in concert_names:
            concert_path = os.path.join(replay_root, current_concert)
            if not os.path.isdir(concert_path):
                continue
            for replay_id in sorted(os.listdir(concert_path)):
                cache_root = os.path.join(concert_path, replay_id, "cache")
                if not os.path.isdir(cache_root):
                    continue
                for run_id in sorted(os.listdir(cache_root)):
                    cache_path = os.path.join(cache_root, run_id)
                    if not os.path.isdir(cache_path):
                        continue
                    metadata = cls._load_metadata(cache_path)
                    if not metadata.get("id") or not metadata.get("runId"):
                        raise ValueError(
                            f"Cache metadata id and runId are required: "
                            f"{current_concert}/{replay_id}/{run_id}"
                        )
                    cache_id = metadata["id"]
                    if cache_id != run_id or metadata["runId"] != run_id:
                        raise ValueError(
                            f"Cache directory, id and runId must match: "
                            f"{current_concert}/{replay_id}/{run_id}"
                        )
                    paths.append((current_concert, cache_id, cache_path, replay_id, metadata))
        return paths

    @classmethod
    def find_cache(cls, replay_root, cache_id, concert_name=None):
        requested_cache_id = str(cache_id)
        safe_cache_id = cls._safe_name(cache_id)
        for current_concert, current_cache_id, cache_path, replay_id, metadata in cls._cache_paths(
            replay_root,
            concert_name=concert_name,
        ):
            if (
                current_cache_id == safe_cache_id
                or metadata.get("runId") == requested_cache_id
            ):
                return current_concert, current_cache_id, cache_path, metadata
        return None

    @classmethod
    def list_for_replay(cls, replay_root, concert_name, replay_id):
        safe_concert_name = cls._safe_name(concert_name)
        safe_replay_id = cls._safe_replay_id(replay_id)
        caches = []
        for _current_concert, cache_id, _, _, metadata in cls._cache_paths(
            replay_root,
            concert_name=safe_concert_name,
        ):
            if metadata.get("sourceReplayId") == safe_replay_id:
                caches.append({
                    "cacheId": cache_id,
                    "runId": metadata.get("runId"),
                    "createdAt": metadata.get("createdAt"),
                    "finishedAt": metadata.get("finishedAt"),
                    "status": metadata.get("status"),
                    "mode": metadata.get("mode"),
                    "player": metadata.get("clientIp") or metadata.get("callerName") or "",
                })
        caches.sort(key=lambda item: item.get("createdAt") or "", reverse=True)
        return caches

    @classmethod
    def latest_for_replay(cls, replay_root, concert_name, replay_id):
        caches = cls.list_for_replay(replay_root, concert_name, replay_id)
        return {
            "available": bool(caches),
            "count": len(caches),
            "latestCacheId": caches[0]["cacheId"] if caches else None,
        }

    @classmethod
    def clear_for_replay(cls, replay_root, concert_name, replay_id, cache_id=None):
        safe_concert_name = cls._safe_name(concert_name)
        safe_replay_id = cls._safe_replay_id(replay_id)
        cache_root = os.path.join(replay_root, safe_concert_name, safe_replay_id, "cache")
        cache_path = (
            os.path.join(cache_root, cls._safe_name(cache_id))
            if cache_id
            else cache_root
        )
        if not os.path.isdir(cache_path):
            return False
        shutil.rmtree(cache_path)
        return True

    @classmethod
    def load_run(cls, replay_root, cache_id, concert_name=None):
        found = cls.find_cache(replay_root, cache_id, concert_name=concert_name)
        if not found:
            raise FileNotFoundError(f"Cache not found: {cache_id}")
        concert_name, current_cache_id, _, metadata = found
        nodes = {}
        for node_id, node in (metadata.get("nodes") or {}).items():
            nodes[node_id] = {
                "id": node_id,
                "name": node.get("name"),
                "type": node.get("type"),
                "status": node.get("status"),
                "logs": node.get("logs", ""),
                "error": node.get("error"),
                "rows": node.get("rows"),
                "columns": node.get("columns", []),
                "durationMs": node.get("durationMs"),
                "loopIterations": node.get("loopIterations"),
                "cacheDurationMs": node.get("cacheDurationMs"),
                "updatedAt": node.get("updatedAt"),
                "result": None,
            }
        return {
            "id": current_cache_id,
            "concertName": concert_name,
            "status": metadata.get("status", "success"),
            "nodes": nodes,
            "createdAt": metadata.get("createdAt"),
            "updatedAt": metadata.get("updatedAt"),
            "finishedAt": metadata.get("finishedAt"),
            "timing": metadata.get("timing"),
            "cache": {
                "enabled": True,
                "cacheId": current_cache_id,
                "sourceReplayId": metadata.get("sourceReplayId"),
            },
        }

    @classmethod
    def load_node_result(
        cls,
        base_path,
        cache_id,
        node_id,
        max_grid_rows=1000,
        offset=0,
        concert_name=None,
    ):
        page = cls.query_node_result(
            base_path,
            cache_id,
            node_id,
            offset=offset,
            limit=max_grid_rows,
            concert_name=concert_name,
        )
        data = page["data"]
        return {
            "kind": "dataframe",
            "rows": page["rows"],
            "columns": page["columns"],
            "dtypes": page["dtypes"],
            "preview": data[:20],
            "data": data,
            "dataLimit": max_grid_rows,
            "offset": offset,
            "returnedRows": len(data),
            "hasMore": page["hasMore"],
            "truncated": page["hasMore"],
        }

    @staticmethod
    def _quote_identifier(value):
        return f'"{str(value).replace(chr(34), chr(34) * 2)}"'

    @staticmethod
    def _is_numeric_type(type_name):
        normalized = str(type_name).upper()
        return any(
            token in normalized
            for token in (
                "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
                "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT",
                "FLOAT", "DOUBLE", "REAL", "DECIMAL",
            )
        )

    @classmethod
    def _filter_sql(cls, item, column_types, params):
        column = item.get("column")
        operator = item.get("operator")
        value = str(item.get("value", ""))
        if column not in column_types:
            raise ValueError(f"Unknown filter column: {column}")
        valid_operators = {
            "contains", "notContains", "startsWith", "endsWith",
            "equals", "notEquals", "gte", "gt", "lte", "lt",
            "empty", "notEmpty", "eq", "ne",
        }
        if operator not in valid_operators:
            raise ValueError(f"Invalid filter operator for {column}: {operator}")
        quoted = cls._quote_identifier(column)
        text_value = f"lower(coalesce(cast({quoted} as varchar), ''))"
        if operator == "empty":
            return f"({quoted} is null or cast({quoted} as varchar) = '')"
        if operator == "notEmpty":
            return f"({quoted} is not null and cast({quoted} as varchar) != '')"
        if not value:
            return None
        if operator in {"contains", "notContains", "startsWith", "endsWith"}:
            params.append(value.casefold())
            expressions = {
                "contains": f"contains({text_value}, ?)",
                "notContains": f"not (contains({text_value}, ?))",
                "startsWith": f"starts_with({text_value}, ?)",
                "endsWith": f"ends_with({text_value}, ?)",
            }
            return expressions[operator]
        normalized_operator = {"eq": "equals", "ne": "notEquals"}.get(operator, operator)
        sql_operator = {
            "equals": "=", "notEquals": "!=", "gte": ">=", "gt": ">",
            "lte": "<=", "lt": "<",
        }[normalized_operator]
        if cls._is_numeric_type(column_types[column]):
            try:
                params.append(float(value))
            except ValueError as exc:
                raise ValueError(f"Numeric filter value required for {column}") from exc
            return f"{quoted} {sql_operator} ?"
        params.append(value.casefold())
        return f"{text_value} {sql_operator} ?"

    @classmethod
    def query_node_result(
        cls,
        base_path,
        cache_id,
        node_id,
        offset=0,
        limit=1000,
        filters=None,
        sorts=None,
        concert_name=None,
    ):
        found = cls.find_cache(base_path, cache_id, concert_name=concert_name)
        if not found:
            raise FileNotFoundError(f"Cache not found: {cache_id}")
        _, _, cache_path, metadata = found
        node = (metadata.get("nodes") or {}).get(node_id)
        if not node:
            raise FileNotFoundError(f"Cache data not found for node: {node_id}")
        if node.get("file"):
            parquet_path = os.path.join(cache_path, node["file"])
        else:
            raise FileNotFoundError(f"Cache data not found for node: {node_id}")
        return cls.query_parquet_result(
            parquet_path,
            offset=offset,
            limit=limit,
            filters=filters,
            sorts=sorts,
        )

    @classmethod
    def query_parquet_result(
        cls,
        parquet_path,
        offset=0,
        limit=1000,
        filters=None,
        sorts=None,
    ):
        if not os.path.isfile(parquet_path):
            raise FileNotFoundError(f"Parquet data not found: {parquet_path}")
        limit = min(limit, 1000)
        with duckdb.connect() as connection:
            description = connection.execute(
                "describe select * from read_parquet(?)",
                [parquet_path],
            ).fetchall()
            columns = [str(row[0]) for row in description]
            column_types = {str(row[0]): str(row[1]) for row in description}
            row_number_column = "__metronome_row_number"
            if row_number_column in column_types:
                raise ValueError(f"Reserved data column name: {row_number_column}")
            source_sql = (
                "select *, file_row_number + 1 as "
                f"{cls._quote_identifier(row_number_column)} "
                "from read_parquet(?, file_row_number = true)"
            )
            where_params = []
            where_parts = []
            for item in filters or []:
                expression = cls._filter_sql(item, column_types, where_params)
                if expression:
                    where_parts.append(expression)
            where_sql = f" where {' and '.join(where_parts)}" if where_parts else ""
            total_rows = int(
                connection.execute(
                    "select count(*) from read_parquet(?)",
                    [parquet_path],
                ).fetchone()[0]
            )
            filtered_rows = int(
                connection.execute(
                    f"select count(*) from ({source_sql}) as source{where_sql}",
                    [parquet_path, *where_params],
                ).fetchone()[0]
            )

            sort_columns = []
            order_parts = []
            for item in sorts or []:
                column = item.get("column")
                direction = item.get("direction")
                if column not in column_types:
                    raise ValueError(f"Unknown sort column: {column}")
                if direction not in {"asc", "desc"}:
                    raise ValueError(f"Invalid sort direction for {column}: {direction}")
                if column in sort_columns:
                    raise ValueError(f"Duplicate sort column: {column}")
                sort_columns.append(column)
                order_parts.append(f"{cls._quote_identifier(column)} {direction}")
            order_sql = f" order by {', '.join(order_parts)}" if order_parts else ""
            selected_columns = ", ".join(
                [cls._quote_identifier(row_number_column)]
                + [cls._quote_identifier(column) for column in columns]
            )
            page = connection.execute(
                f"select {selected_columns} from ({source_sql}) as source"
                f"{where_sql}{order_sql} limit ? offset ?",
                [parquet_path, *where_params, limit, offset],
            ).fetch_df()

        row_numbers = [int(value) for value in page.pop(row_number_column).tolist()]
        page = page.astype(object).where(pd.notnull(page), None)
        page = page.replace({float("inf"): None, float("-inf"): None})
        data = page.to_dict(orient="records")
        return {
            "kind": "dataframe",
            "rows": total_rows,
            "filteredRows": filtered_rows,
            "columns": columns,
            "dtypes": column_types,
            "data": data,
            "rowNumbers": row_numbers,
            "offset": offset,
            "returnedRows": len(data),
            "hasMore": offset + len(data) < filtered_rows,
        }

    @classmethod
    def load_model_artifact(
        cls,
        base_path,
        cache_id,
        node_id,
        file_format="lp",
        concert_name=None,
        artifact_key=None,
    ):
        if file_format not in {"lp", "mps"}:
            raise ValueError(f"Unsupported model format: {file_format}")
        found = cls.find_cache(base_path, cache_id, concert_name=concert_name)
        if not found:
            raise FileNotFoundError(f"Cache not found: {cache_id}")
        _, _, cache_path, _ = found
        safe_node_id = cls._safe_name(node_id)
        path = (
            os.path.join(
                cache_path,
                safe_node_id,
                f"{cls._safe_name(artifact_key)}.{file_format}",
            )
            if artifact_key is not None
            else os.path.join(cache_path, f"{safe_node_id}.{file_format}")
        )
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Model artifact not found for node: {node_id}")
        with open(path, "r", encoding="utf-8", errors="replace") as file:
            return file.read()
