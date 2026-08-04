from datetime import datetime
import json
import os
import re

import pandas as pd


class ReplayDataStore:
    def __init__(
        self,
        base_path="./replay",
        concert_name="untitled_concert",
        replay_id=None,
        run_timestamp=None,
    ):
        self.base_path = base_path
        self.concert_name = self._safe_name(concert_name)
        self.loading_replay = bool(replay_id)
        self.run_timestamp = run_timestamp or datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        self.replay_id = (
            self._safe_replay_id(replay_id)
            if replay_id
            else self.replay_id_for_timestamp(self.run_timestamp)
        )
        self.concert_path = os.path.join(self.base_path, self.concert_name)
        os.makedirs(self.concert_path, exist_ok=True)

        self.path = os.path.join(self.concert_path, self.replay_id)
        if not self.loading_replay:
            os.makedirs(self.path, exist_ok=True)

    @staticmethod
    def _safe_name(name):
        return re.sub(r"[^a-zA-Z0-9_.-]+", "_", name or "").strip("_") or "untitled"

    @classmethod
    def _safe_replay_id(cls, name):
        return cls._safe_name(str(name or "").replace("\\", "/").strip("/"))

    @classmethod
    def replay_id_for_timestamp(cls, run_timestamp):
        text = str(run_timestamp or datetime.now().strftime("%Y%m%d_%H%M%S_%f"))
        return cls._safe_name(text)

    def _path_for_task(self, task, loop_key=None):
        safe_task_id = self._safe_name(task.id)
        if loop_key:
            task_path = os.path.join(self.path, safe_task_id)
            if not self.loading_replay:
                os.makedirs(task_path, exist_ok=True)
            return os.path.join(task_path, f"{self._safe_name(loop_key)}.parquet")
        return os.path.join(self.path, f"{safe_task_id}.parquet")

    def save_metadata(self, metadata):
        if self.loading_replay:
            return
        with open(os.path.join(self.path, "metadata.json"), "w", encoding="utf-8") as file:
            json.dump(metadata, file, ensure_ascii=False, allow_nan=True, indent=2)

    @staticmethod
    def _load_metadata(path):
        metadata_path = os.path.join(path, "metadata.json")
        if not os.path.exists(metadata_path):
            return {}
        with open(metadata_path, "r", encoding="utf-8") as file:
            return json.load(file)

    def save_task_result(self, task, df, loop_key=None):
        if df is None:
            return
        if not isinstance(df, pd.DataFrame):
            raise TypeError("Replay task results must be pandas DataFrame objects.")
        df.to_parquet(self._path_for_task(task, loop_key=loop_key))

    def load_task_result(self, task, loop_key=None):
        path = self._path_for_task(task, loop_key=loop_key)
        if not os.path.exists(path):
            suffix = f" / loop {loop_key}" if loop_key else ""
            raise FileNotFoundError(f"Replay data not found for node: {task.id}{suffix}")
        return pd.read_parquet(path)

    @classmethod
    def list_replays(cls, base_path="./replay", concert_name=None, cache_lookup=None):
        if not os.path.isdir(base_path):
            return []

        concert_names = (
            [cls._safe_name(concert_name)] if concert_name else sorted(os.listdir(base_path))
        )
        replays = []

        for current_concert in concert_names:
            concert_path = os.path.join(base_path, current_concert)
            if not os.path.isdir(concert_path):
                continue

            for replay_id in sorted(os.listdir(concert_path)):
                replay_path = os.path.join(concert_path, replay_id)
                if not os.path.isdir(replay_path):
                    continue
                if replay_id == "cache":
                    continue
                files = sorted(file_name for file_name in os.listdir(replay_path) if file_name.endswith(".parquet"))
                metadata = cls._load_metadata(replay_path)
                if not files and not metadata:
                    continue
                cache = cache_lookup(current_concert, replay_id) if cache_lookup else None
                display_concert_name = metadata.get("concertName") or current_concert

                replays.append(
                    {
                        "id": replay_id,
                        "concertName": display_concert_name,
                        "label": f"{display_concert_name}/{replay_id}",
                        "createdAt": metadata.get("createdAt") or replay_id,
                        "trigger": metadata.get("trigger"),
                        "executedBy": metadata.get("executedBy", {}),
                        "sourceKind": metadata.get("sourceKind"),
                        "sourceLabel": metadata.get("sourceLabel"),
                        "sourceDetail": metadata.get("sourceDetail"),
                        "callerName": metadata.get("callerName"),
                        "params": metadata.get("params", {}),
                        "inputParams": metadata.get("inputParams"),
                        "calledParams": metadata.get("calledParams"),
                        "callerParams": metadata.get("callerParams"),
                        "globalVariables": metadata.get("globalVariables", []),
                        "inputVariables": metadata.get("inputVariables", []),
                        "dataFiles": files,
                        "cache": cache or {"available": False},
                    }
                )
        replays.sort(key=lambda item: item["createdAt"], reverse=True)
        return replays
