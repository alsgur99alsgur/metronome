import json
import os
import re
import shutil
import tempfile
from threading import Lock

import pandas as pd


class ResourceStore:
    KINDS = {"cache", "file"}
    SCOPES = {"stage", "concert"}
    STAGE_CACHE_MANIFEST = "cache_resources.json"

    def __init__(self, stage_root, tmp_root):
        self.stage_root = os.path.abspath(stage_root)
        self.tmp_root = os.path.abspath(tmp_root)
        os.makedirs(self.stage_root, exist_ok=True)
        os.makedirs(self.tmp_root, exist_ok=True)
        self._guard = Lock()
        self._locks = {}
        self._cache = {}
        self._load_stage_cache_names()

    def _stage_cache_manifest_path(self):
        return os.path.join(self.stage_root, self.STAGE_CACHE_MANIFEST)

    def _load_stage_cache_names(self):
        path = self._stage_cache_manifest_path()
        if not os.path.exists(path):
            return
        with open(path, "r", encoding="utf-8") as file:
            payload = json.load(file)
        if not isinstance(payload, dict) or not isinstance(payload.get("caches"), list):
            raise ValueError(f"{self.STAGE_CACHE_MANIFEST} must contain a 'caches' list.")
        names = payload["caches"]
        if any(not isinstance(name, str) for name in names):
            raise ValueError(f"{self.STAGE_CACHE_MANIFEST} cache names must be strings.")
        validated = [self.validate_name(name) for name in names]
        if len(validated) != len(set(validated)):
            raise ValueError(f"{self.STAGE_CACHE_MANIFEST} contains duplicate cache names.")
        for name in validated:
            self._cache[("cache", "stage", name, None)] = pd.DataFrame()

    def _save_stage_cache_names_unlocked(self):
        path = self._stage_cache_manifest_path()
        names = sorted(
            key[2]
            for key in self._cache
            if key[0] == "cache" and key[1] == "stage"
        )
        fd, temporary = tempfile.mkstemp(
            prefix=f".{self.STAGE_CACHE_MANIFEST}.",
            suffix=".tmp",
            dir=self.stage_root,
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump({"caches": names}, file, ensure_ascii=False, indent=2)
                file.write("\n")
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    @staticmethod
    def validate_name(name):
        text = str(name or "").strip()
        if (
            not text
            or text in {".", ".."}
            or "/" in text
            or "\\" in text
            or not re.fullmatch(r"[A-Za-z0-9_.-]+", text)
        ):
            raise ValueError("Resource name must contain only letters, numbers, '_', '-' or '.'.")
        return text

    @classmethod
    def _validate_kind_scope(cls, kind, scope):
        if kind not in cls.KINDS:
            raise ValueError(f"Invalid resource kind: {kind}")
        if scope not in cls.SCOPES:
            raise ValueError(f"Invalid resource scope: {scope}")

    def _key(self, kind, scope, name, run_id=None):
        self._validate_kind_scope(kind, scope)
        name = self.validate_name(name)
        if scope == "concert" and not run_id:
            raise ValueError("runId is required for Concert resources.")
        return kind, scope, name, str(run_id) if scope == "concert" else None

    def _lock_for(self, key):
        with self._guard:
            return self._locks.setdefault(key, Lock())

    def _file_path(self, scope, name, run_id=None):
        if scope == "stage":
            root = os.path.join(self.stage_root, "file")
        else:
            root = os.path.join(self.tmp_root, str(run_id), "file")
        os.makedirs(root, exist_ok=True)
        return os.path.join(root, f"{name}.parquet")

    @staticmethod
    def _atomic_write(df, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd, temporary = tempfile.mkstemp(
            prefix=f".{os.path.basename(path)}.",
            suffix=".tmp",
            dir=os.path.dirname(path),
        )
        os.close(fd)
        try:
            df.to_parquet(temporary)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _exists_unlocked(self, key):
        kind, scope, name, run_id = key
        if kind == "cache":
            return key in self._cache
        return os.path.exists(self._file_path(scope, name, run_id))

    def _read_unlocked(self, key):
        kind, scope, name, run_id = key
        if kind == "cache":
            if key not in self._cache:
                raise FileNotFoundError(f"{scope.title()} Cache not found: {name}")
            return self._cache[key].copy(deep=True)
        path = self._file_path(scope, name, run_id)
        if not os.path.exists(path):
            raise FileNotFoundError(f"{scope.title()} File not found: {name}")
        return pd.read_parquet(path)

    def _write_unlocked(self, key, dataframe):
        kind, scope, name, run_id = key
        snapshot = dataframe.copy(deep=True)
        if kind == "cache":
            self._cache[key] = snapshot
        else:
            self._atomic_write(snapshot, self._file_path(scope, name, run_id))

    def list_stage(self):
        with self._guard:
            caches = sorted(
                key[2]
                for key in self._cache
                if key[0] == "cache" and key[1] == "stage"
            )
        file_root = os.path.join(self.stage_root, "file")
        files = []
        if os.path.isdir(file_root):
            files = sorted(
                item[:-8]
                for item in os.listdir(file_root)
                if item.endswith(".parquet") and os.path.isfile(os.path.join(file_root, item))
            )
        return [
            *({"kind": "cache", "name": name} for name in caches),
            *({"kind": "file", "name": name} for name in files),
        ]

    def create_stage(self, kind, name):
        key = self._key(kind, "stage", name)
        with self._lock_for(key):
            if self._exists_unlocked(key):
                raise FileExistsError(f"Stage {kind.title()} already exists: {key[2]}")
            if kind == "cache":
                with self._guard:
                    self._cache[key] = pd.DataFrame()
                    try:
                        self._save_stage_cache_names_unlocked()
                    except Exception:
                        self._cache.pop(key, None)
                        raise
            else:
                self._write_unlocked(key, pd.DataFrame())
        return {"kind": kind, "name": key[2]}

    def delete_stage(self, kind, name):
        key = self._key(kind, "stage", name)
        with self._lock_for(key):
            if not self._exists_unlocked(key):
                raise FileNotFoundError(f"Stage {kind.title()} not found: {key[2]}")
            if kind == "cache":
                with self._guard:
                    previous = self._cache.pop(key)
                    try:
                        self._save_stage_cache_names_unlocked()
                    except Exception:
                        self._cache[key] = previous
                        raise
            else:
                os.unlink(self._file_path("stage", key[2]))
        with self._guard:
            self._locks.pop(key, None)

    def read(self, kind, scope, name, run_id=None):
        key = self._key(kind, scope, name, run_id)
        with self._lock_for(key):
            return self._read_unlocked(key)

    def append(self, kind, scope, name, dataframe, run_id=None):
        if not isinstance(dataframe, pd.DataFrame):
            raise TypeError("Resource append input must be a pandas DataFrame.")
        key = self._key(kind, scope, name, run_id)
        with self._lock_for(key):
            exists = self._exists_unlocked(key)
            if not exists and scope == "stage":
                raise FileNotFoundError(f"Stage {kind.title()} not found: {key[2]}")
            current = self._read_unlocked(key) if exists else pd.DataFrame()
            if len(current.columns) and list(current.columns) != list(dataframe.columns):
                raise ValueError("Resource and input DataFrame columns must match exactly.")
            result = dataframe.copy(deep=True) if not len(current.columns) else pd.concat(
                [current, dataframe],
                ignore_index=True,
            )
            self._write_unlocked(key, result)
            return result.copy(deep=True)

    def delete_rows(self, kind, scope, name, condition, variables=None, run_id=None):
        condition = str(condition or "").strip()
        if not condition:
            raise ValueError("Delete condition is required.")
        key = self._key(kind, scope, name, run_id)
        with self._lock_for(key):
            current = self._read_unlocked(key)
            try:
                matched = current.query(condition, local_dict=variables or {})
            except Exception as exc:
                raise ValueError(f"Invalid pandas query condition: {exc}") from exc
            result = current.drop(index=matched.index).reset_index(drop=True)
            self._write_unlocked(key, result)
            return result.copy(deep=True)

    def cleanup_run(self, run_id):
        run_id = str(run_id)
        with self._guard:
            keys = [key for key in self._cache if key[1] == "concert" and key[3] == run_id]
            for key in keys:
                self._cache.pop(key, None)
            lock_keys = [key for key in self._locks if key[1] == "concert" and key[3] == run_id]
            for key in lock_keys:
                self._locks.pop(key, None)
        path = os.path.join(self.tmp_root, run_id)
        if os.path.isdir(path):
            shutil.rmtree(path)
