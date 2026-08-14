import json
import os
import time
from datetime import datetime, timezone
from threading import Lock

import duckdb
import pandas as pd
import psutil
import pyarrow.parquet as pq

from atomic_file import atomic_write_json, atomic_write_parquet


class _InterProcessLock:
    """Small cross-platform writer lock based on exclusive lock-file creation."""

    def __init__(self, path, timeout=60):
        self.path = path
        self.timeout = timeout
        self.fd = None

    @staticmethod
    def _process_created_at(pid):
        return psutil.Process(pid).create_time()

    def _write_owner(self):
        payload = {
            "pid": os.getpid(),
            "processCreatedAt": self._process_created_at(os.getpid()),
            "lockCreatedAt": time.time(),
        }
        os.write(self.fd, json.dumps(payload).encode("utf-8"))
        os.fsync(self.fd)

    def _reclaim_if_stale(self):
        try:
            initial_stat = os.stat(self.path)
        except FileNotFoundError:
            return True
        except OSError:
            return False
        try:
            with open(self.path, "r", encoding="utf-8") as file:
                owner = json.load(file)
        except FileNotFoundError:
            return True
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            # An owner may still be between exclusive creation and writing JSON.
            if time.time() - initial_stat.st_mtime < 5:
                return False
            owner = None

        stale = owner is None
        if owner is not None:
            try:
                pid = int(owner["pid"])
                recorded_created_at = float(owner["processCreatedAt"])
                actual_created_at = self._process_created_at(pid)
                stale = abs(actual_created_at - recorded_created_at) > 0.01
            except (KeyError, TypeError, ValueError, psutil.NoSuchProcess):
                stale = True
            except (psutil.AccessDenied, psutil.Error):
                stale = False
        if not stale:
            return False

        try:
            current_stat = os.stat(self.path)
            if (
                current_stat.st_dev,
                current_stat.st_ino,
                current_stat.st_mtime_ns,
                current_stat.st_size,
            ) != (
                initial_stat.st_dev,
                initial_stat.st_ino,
                initial_stat.st_mtime_ns,
                initial_stat.st_size,
            ):
                return False
            os.unlink(self.path)
            return True
        except FileNotFoundError:
            return True

    def __enter__(self):
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try:
                    self._write_owner()
                except Exception:
                    os.close(self.fd)
                    self.fd = None
                    try:
                        os.unlink(self.path)
                    except FileNotFoundError:
                        pass
                    raise
                return self
            except FileExistsError:
                if self._reclaim_if_stale():
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Cache writer lock timed out: {self.path}")
                time.sleep(0.02)

    def __exit__(self, *_args):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass


class ResourceStore:
    """Stage caches are immutable/versioned; Concert caches are memory-only."""

    SCOPES = {"stage", "concert"}

    def __init__(self, stage_root, _tmp_root=None):
        self.stage_root = os.path.abspath(stage_root)
        self.cache_root = os.path.join(self.stage_root, "cache")
        os.makedirs(self.cache_root, exist_ok=True)
        self._guard = Lock()
        self._concert_cache = {}

    @staticmethod
    def _path_component(name):
        # Path containment only; Cache-name format is owned by the current schema/UI.
        text = str(name or "")
        if not text or text in {".", ".."} or "/" in text or "\\" in text:
            raise ValueError("Cache name is required and must not contain path separators.")
        return text

    @classmethod
    def _key(cls, scope, name, run_id=None):
        if scope not in cls.SCOPES:
            raise ValueError(f"Invalid Cache scope: {scope}")
        name = cls._path_component(name)
        if scope == "concert" and not run_id:
            raise ValueError("runId is required for Concert Cache.")
        return scope, name, str(run_id) if scope == "concert" else None

    def _pointer_path(self, name):
        return os.path.join(self.cache_root, f"{name}.current.json")

    def _lock_path(self, name):
        return os.path.join(self.cache_root, f".{name}.lock")

    def _read_pointer(self, name):
        path = self._pointer_path(name)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Stage Cache not found: {name}")
        with open(path, "r", encoding="utf-8") as file:
            payload = json.load(file)
        file_key = payload.get("fileKey")
        if not isinstance(file_key, str) or os.path.basename(file_key) != file_key:
            raise ValueError(f"Invalid Stage Cache pointer: {name}")
        data_path = os.path.join(self.cache_root, file_key)
        if not os.path.isfile(data_path):
            raise FileNotFoundError(f"Stage Cache version not found: {file_key}")
        return file_key, data_path

    def _next_version(self, name):
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S_%f")
        base = f"{name}_{timestamp}"
        candidate = f"{base}.parquet"
        suffix = 2
        while os.path.exists(os.path.join(self.cache_root, candidate)):
            candidate = f"{base}_{suffix}.parquet"
            suffix += 1
        return candidate

    def _write_pointer(self, name, file_key):
        atomic_write_json(self._pointer_path(name), {"fileKey": file_key})

    def _write_version(self, name, dataframe):
        file_key = self._next_version(name)
        final_path = os.path.join(self.cache_root, file_key)
        atomic_write_parquet(dataframe, final_path, index=False)
        self._write_pointer(name, file_key)
        return file_key

    @staticmethod
    def _read_parquet(path):
        if not pq.read_schema(path).names:
            return pd.DataFrame()
        escaped = path.replace("'", "''")
        return duckdb.sql(f"SELECT * FROM read_parquet('{escaped}')").df()

    def list_stage(self):
        resources = []
        for item in sorted(os.listdir(self.cache_root)):
            if not item.endswith(".current.json"):
                continue
            name = item[: -len(".current.json")]
            try:
                file_key, _ = self._read_pointer(name)
                resources.append({"name": name, "fileKey": file_key})
            except (ValueError, FileNotFoundError):
                resources.append({"name": name, "error": "Invalid Cache pointer."})
        return resources

    def create_stage(self, name):
        name = self._path_component(name)
        with _InterProcessLock(self._lock_path(name)):
            if os.path.exists(self._pointer_path(name)):
                raise FileExistsError(f"Stage Cache already exists: {name}")
            file_key = self._write_version(name, pd.DataFrame())
        return {"name": name, "fileKey": file_key}

    def delete_stage(self, name):
        name = self._path_component(name)
        with _InterProcessLock(self._lock_path(name)):
            if not os.path.exists(self._pointer_path(name)):
                raise FileNotFoundError(f"Stage Cache not found: {name}")
            os.unlink(self._pointer_path(name))

    def read(self, scope, name, run_id=None, file_key=None):
        key = self._key(scope, name, run_id)
        if scope == "concert":
            with self._guard:
                if key not in self._concert_cache:
                    raise FileNotFoundError(f"Concert Cache not found: {name}")
                return self._concert_cache[key].copy(deep=True), None
        if file_key is None:
            file_key, path = self._read_pointer(name)
        else:
            if os.path.basename(file_key) != file_key:
                raise ValueError(f"Invalid Stage Cache file key: {file_key}")
            path = os.path.join(self.cache_root, file_key)
            if not os.path.isfile(path):
                raise FileNotFoundError(f"Stage Cache version not found: {file_key}")
        return self._read_parquet(path), file_key

    def schema(self, scope, name, run_id=None):
        dataframe, _ = self.read(scope, name, run_id=run_id)
        return [{"name": str(column), "type": str(dtype)} for column, dtype in zip(dataframe.columns, dataframe.dtypes)]

    def preview(self, scope, name, limit=1000, run_id=None):
        dataframe, _ = self.read(scope, name, run_id=run_id)
        return dataframe.head(limit).copy(), int(len(dataframe))

    def append(self, scope, name, dataframe, run_id=None):
        if not isinstance(dataframe, pd.DataFrame):
            raise TypeError("Cache append input must be a pandas DataFrame.")
        key = self._key(scope, name, run_id)
        if scope == "concert":
            with self._guard:
                current = self._concert_cache.get(key)
                result = dataframe.copy(deep=True) if current is None or not len(current.columns) else pd.concat([current, dataframe], ignore_index=True)
                self._concert_cache[key] = result
            return result.copy(deep=True)
        with _InterProcessLock(self._lock_path(name)):
            _, path = self._read_pointer(name)
            current = self._read_parquet(path)
            if len(current.columns) and list(current.columns) != list(dataframe.columns):
                raise ValueError("Cache and input DataFrame columns must match exactly.")
            result = dataframe.copy(deep=True) if not len(current.columns) else pd.concat([current, dataframe], ignore_index=True)
            self._write_version(name, result)
        return result.copy(deep=True)

    def delete_rows(self, scope, name, condition, variables=None, run_id=None):
        condition = str(condition or "").strip()
        if not condition:
            raise ValueError("Delete condition is required.")
        key = self._key(scope, name, run_id)
        if scope == "concert":
            with self._guard:
                if key not in self._concert_cache:
                    raise FileNotFoundError(f"Concert Cache not found: {name}")
                current = self._concert_cache[key]
                matched = current.query(condition, local_dict=variables or {})
                result = current.drop(index=matched.index).reset_index(drop=True)
                self._concert_cache[key] = result
            return result.copy(deep=True)
        with _InterProcessLock(self._lock_path(name)):
            _, path = self._read_pointer(name)
            current = self._read_parquet(path)
            matched = current.query(condition, local_dict=variables or {})
            result = current.drop(index=matched.index).reset_index(drop=True)
            self._write_version(name, result)
        return result.copy(deep=True)

    def cleanup_run(self, run_id):
        run_id = str(run_id)
        with self._guard:
            for key in [item for item in self._concert_cache if item[2] == run_id]:
                self._concert_cache.pop(key, None)

    def path_for_file_key(self, file_key):
        if os.path.basename(file_key) != file_key:
            raise ValueError(f"Invalid Stage Cache file key: {file_key}")
        path = os.path.join(self.cache_root, file_key)
        if not os.path.isfile(path):
            raise FileNotFoundError(f"Stage Cache version not found: {file_key}")
        return path
