import json
import os
import shutil
import time
from threading import Event, Thread

from app_config import config_int


class StorageRetentionManager:
    def __init__(self, replay_root, run_status_root, stage_root, check_interval_seconds=300):
        self.replay_root = os.path.abspath(replay_root)
        self.run_status_root = os.path.abspath(run_status_root)
        self.stage_cache_root = os.path.join(os.path.abspath(stage_root), "cache")
        self.check_interval_seconds = check_interval_seconds
        self._stop = Event()
        self._thread = None

    @staticmethod
    def _expired(path, cutoff):
        try:
            return os.path.getmtime(path) < cutoff
        except FileNotFoundError:
            return False

    def cleanup_once(self):
        retention_days = config_int("storage", "retentionDays")
        if retention_days < 1:
            raise ValueError("storage.retentionDays must be at least 1.")
        cutoff = time.time() - retention_days * 86400
        deleted = {
            "replays": 0,
            "caches": 0,
            "runStatuses": 0,
            "stageCacheVersions": 0,
            "stageCachePointers": 0,
            "temporaryFiles": 0,
        }

        if os.path.isdir(self.replay_root):
            for concert_name in os.listdir(self.replay_root):
                concert_path = os.path.join(self.replay_root, concert_name)
                if not os.path.isdir(concert_path):
                    continue
                for replay_id in os.listdir(concert_path):
                    replay_path = os.path.join(concert_path, replay_id)
                    if not os.path.isdir(replay_path):
                        continue
                    cache_path = os.path.join(replay_path, "cache")
                    if os.path.isdir(cache_path):
                        for run_id in os.listdir(cache_path):
                            run_cache_path = os.path.join(cache_path, run_id)
                            if not os.path.isdir(run_cache_path):
                                continue
                            cache_metadata = os.path.join(run_cache_path, "metadata.json")
                            cache_age_path = (
                                cache_metadata
                                if os.path.isfile(cache_metadata)
                                else run_cache_path
                            )
                            if self._expired(cache_age_path, cutoff):
                                shutil.rmtree(run_cache_path)
                                deleted["caches"] += 1
                        try:
                            os.rmdir(cache_path)
                        except OSError:
                            pass
                    replay_metadata = os.path.join(replay_path, "metadata.json")
                    replay_age_path = replay_metadata if os.path.isfile(replay_metadata) else replay_path
                    if self._expired(replay_age_path, cutoff):
                        for item in os.listdir(replay_path):
                            if item == "cache":
                                continue
                            item_path = os.path.join(replay_path, item)
                            if os.path.isdir(item_path):
                                shutil.rmtree(item_path)
                            else:
                                os.unlink(item_path)
                        deleted["replays"] += 1
                    try:
                        os.rmdir(replay_path)
                    except OSError:
                        pass
                try:
                    os.rmdir(concert_path)
                except OSError:
                    pass

        if os.path.isdir(self.run_status_root):
            for file_name in os.listdir(self.run_status_root):
                if not file_name.endswith(".json"):
                    continue
                path = os.path.join(self.run_status_root, file_name)
                if os.path.isfile(path) and self._expired(path, cutoff):
                    os.unlink(path)
                    deleted["runStatuses"] += 1

        if os.path.isdir(self.stage_cache_root):
            for file_name in os.listdir(self.stage_cache_root):
                path = os.path.join(self.stage_cache_root, file_name)
                if not os.path.isfile(path) or not self._expired(path, cutoff):
                    continue
                if file_name.endswith(".parquet"):
                    try:
                        os.unlink(path)
                        deleted["stageCacheVersions"] += 1
                    except FileNotFoundError:
                        pass
                elif file_name.endswith(".tmp"):
                    try:
                        os.unlink(path)
                        deleted["temporaryFiles"] += 1
                    except FileNotFoundError:
                        pass

            for file_name in os.listdir(self.stage_cache_root):
                if not file_name.endswith(".current.json"):
                    continue
                pointer_path = os.path.join(self.stage_cache_root, file_name)
                try:
                    with open(pointer_path, "r", encoding="utf-8") as file:
                        file_key = json.load(file).get("fileKey")
                    valid_key = (
                        isinstance(file_key, str)
                        and os.path.basename(file_key) == file_key
                    )
                    target_exists = valid_key and os.path.isfile(
                        os.path.join(self.stage_cache_root, file_key)
                    )
                    if target_exists:
                        continue
                    os.unlink(pointer_path)
                    deleted["stageCachePointers"] += 1
                except FileNotFoundError:
                    pass
                except (OSError, ValueError, TypeError, json.JSONDecodeError):
                    if self._expired(pointer_path, cutoff):
                        try:
                            os.unlink(pointer_path)
                            deleted["stageCachePointers"] += 1
                        except FileNotFoundError:
                            pass
        return deleted

    def _run(self):
        while not self._stop.is_set():
            try:
                self.cleanup_once()
            except Exception as exc:
                print(f"Storage retention cleanup failed: {exc}")
            self._stop.wait(self.check_interval_seconds)

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = Thread(
            target=self._run,
            name="storage-retention",
            daemon=True,
        )
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
            self._thread = None
