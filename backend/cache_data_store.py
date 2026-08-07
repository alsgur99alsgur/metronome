from datetime import datetime
import json
import os
import re
import shutil
from threading import Lock

import pandas as pd


class CacheDataStore:
    def __init__(
        self,
        replay_root="./replay",
        concert_name="untitled_concert",
        source_replay_id=None,
        metadata=None,
    ):
        self.replay_root = replay_root
        self.concert_name = self._safe_name(concert_name)
        self.source_replay_id = self._safe_replay_id(source_replay_id)
        self.cache_id = self._safe_name(self.source_replay_id)
        self.path = os.path.join(
            self.replay_root, self.concert_name, self.source_replay_id, "cache"
        )
        os.makedirs(self.path, exist_ok=True)
        self.metadata_path = os.path.join(self.path, "metadata.json")
        self.lock = Lock()
        self.metadata = {
            "id": self.cache_id,
            "concertName": self.concert_name,
            "sourceReplayId": self.source_replay_id,
            "createdAt": datetime.utcnow().isoformat() + "Z",
            "nodes": {},
            **(metadata or {}),
        }
        self._write_metadata()

    @staticmethod
    def _safe_name(name):
        return re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(name or "")).strip("_") or "untitled"

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
        with open(self.metadata_path, "w", encoding="utf-8") as file:
            json.dump(self.metadata, file, ensure_ascii=False, allow_nan=True, indent=2)

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

        if isinstance(result, pd.DataFrame):
            file_name = f"{self._safe_name(task.id)}.parquet"
            result.to_parquet(os.path.join(self.path, file_name))
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
    def _cache_paths(cls, replay_root="./replay"):
        if not os.path.isdir(replay_root):
            return []
        paths = []
        for concert_name in sorted(os.listdir(replay_root)):
            concert_path = os.path.join(replay_root, concert_name)
            if not os.path.isdir(concert_path):
                continue
            for replay_id in sorted(os.listdir(concert_path)):
                cache_path = os.path.join(concert_path, replay_id, "cache")
                if not os.path.isdir(cache_path):
                    continue
                if "metadata.json" not in os.listdir(cache_path):
                    continue
                metadata = cls._load_metadata(cache_path)
                cache_id = metadata.get("id") or cls._safe_name(replay_id)
                paths.append((concert_name, cache_id, cache_path, replay_id, metadata))
        return paths

    @classmethod
    def find_cache(cls, replay_root, cache_id):
        requested_cache_id = str(cache_id)
        safe_cache_id = cls._safe_name(cache_id)
        safe_replay_id = cls._safe_replay_id(cache_id)
        for concert_name, current_cache_id, cache_path, replay_id, metadata in cls._cache_paths(replay_root):
            if (
                current_cache_id == safe_cache_id
                or metadata.get("sourceReplayId") == safe_replay_id
                or metadata.get("runId") == requested_cache_id
            ):
                return concert_name, current_cache_id, cache_path, metadata
        return None

    @classmethod
    def latest_for_replay(cls, replay_root, concert_name, replay_id):
        safe_concert_name = cls._safe_name(concert_name)
        safe_replay_id = cls._safe_replay_id(replay_id)
        for current_concert, cache_id, _, _, metadata in cls._cache_paths(replay_root):
            if current_concert != safe_concert_name:
                continue
            if metadata.get("sourceReplayId") == safe_replay_id:
                return {
                    "available": True,
                    "cacheId": cache_id,
                    "createdAt": metadata.get("createdAt"),
                    "mode": metadata.get("mode"),
                }
        return {"available": False}

    @classmethod
    def clear_for_replay(cls, replay_root, concert_name, replay_id):
        safe_concert_name = cls._safe_name(concert_name)
        safe_replay_id = cls._safe_replay_id(replay_id)
        cache_path = os.path.join(replay_root, safe_concert_name, safe_replay_id, "cache")
        if not os.path.isdir(cache_path):
            return False
        shutil.rmtree(cache_path)
        return True

    @classmethod
    def load_run(cls, replay_root, cache_id):
        found = cls.find_cache(replay_root, cache_id)
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
            "cache": {"enabled": True, "cacheId": current_cache_id},
        }

    @classmethod
    def load_node_result(
        cls,
        base_path,
        cache_id,
        node_id,
        max_grid_rows=1000,
        offset=0,
    ):
        found = cls.find_cache(base_path, cache_id)
        if not found:
            raise FileNotFoundError(f"Cache not found: {cache_id}")
        _, _, cache_path, metadata = found
        node = (metadata.get("nodes") or {}).get(node_id)
        if not node or not node.get("file"):
            raise FileNotFoundError(f"Cache data not found for node: {node_id}")
        df = pd.read_parquet(os.path.join(cache_path, node["file"]))
        dtypes = {str(column): str(dtype) for column, dtype in df.dtypes.items()}
        grid_df = df.iloc[offset : offset + max_grid_rows].astype(object)
        grid_df = grid_df.where(pd.notnull(grid_df), None)
        grid_df = grid_df.replace({float("inf"): None, float("-inf"): None})
        data = grid_df.to_dict(orient="records")
        return {
            "kind": "dataframe",
            "rows": int(len(df)),
            "columns": list(df.columns),
            "dtypes": dtypes,
            "preview": data[:20],
            "data": data,
            "dataLimit": max_grid_rows,
            "offset": offset,
            "returnedRows": len(data),
            "hasMore": offset + len(data) < len(df),
            "truncated": offset + len(data) < len(df),
        }

    @classmethod
    def load_model_artifact(cls, base_path, cache_id, node_id, file_format="lp"):
        if file_format not in {"lp", "mps"}:
            raise ValueError(f"Unsupported model format: {file_format}")
        found = cls.find_cache(base_path, cache_id)
        if not found:
            raise FileNotFoundError(f"Cache not found: {cache_id}")
        _, _, cache_path, _ = found
        safe_node_id = cls._safe_name(node_id)
        path = os.path.join(cache_path, f"{safe_node_id}.{file_format}")
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Model artifact not found for node: {node_id}")
        with open(path, "r", encoding="utf-8", errors="replace") as file:
            return file.read()
