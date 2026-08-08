import json
import os
import time
from datetime import datetime, timezone
from threading import Event, Lock, Thread
from uuid import uuid4


def _now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _epoch_from_iso(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise ValueError("firstRunAt must be an ISO date-time.") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


class TimerManager:
    def __init__(self, path, run_callback, status_callback=None, poll_seconds=0.5):
        self.path = os.path.abspath(path)
        self.run_callback = run_callback
        self.status_callback = status_callback
        self.poll_seconds = poll_seconds
        self._lock = Lock()
        self._stop_event = Event()
        self._thread = None
        self._timers = {}
        self._load()

    @staticmethod
    def _validate(item, existing=None):
        if not isinstance(item, dict):
            raise ValueError("Timer must be an object.")
        name = str(item.get("name", "")).strip()
        concert_name = str(item.get("concertName", "")).strip()
        interval_seconds = int(item.get("intervalSeconds", 0))
        params = item.get("params", {})
        first_run_at = str(item.get("firstRunAt", "")).strip()
        if not name:
            raise ValueError("Timer name is required.")
        if not concert_name:
            raise ValueError("concertName is required.")
        if interval_seconds < 1:
            raise ValueError("intervalSeconds must be at least 1.")
        if not isinstance(params, dict):
            raise ValueError("params must be an object.")
        first_epoch = _epoch_from_iso(first_run_at)
        previous = existing or {}
        return {
            "id": str(item.get("id") or uuid4()),
            "name": name,
            "concertName": concert_name,
            "intervalSeconds": interval_seconds,
            "firstRunAt": datetime.fromtimestamp(first_epoch, timezone.utc).isoformat().replace("+00:00", "Z"),
            "enabled": bool(item.get("enabled", True)),
            "params": params,
            "createdAt": previous.get("createdAt") or item.get("createdAt") or _now_iso(),
            "updatedAt": _now_iso(),
            "lastRunAt": previous.get("lastRunAt"),
            "lastRunId": previous.get("lastRunId"),
            "lastStatus": previous.get("lastStatus"),
            "lastDurationMs": previous.get("lastDurationMs"),
            "lastError": previous.get("lastError"),
        }

    @staticmethod
    def _next_epoch(timer, now=None):
        if not timer["enabled"]:
            return None
        now = time.time() if now is None else now
        first = _epoch_from_iso(timer["firstRunAt"])
        if first > now:
            return first
        interval = timer["intervalSeconds"]
        return first + (int((now - first) // interval) + 1) * interval

    def _load(self):
        if not os.path.exists(self.path):
            return
        with open(self.path, "r", encoding="utf-8") as file:
            items = json.load(file)
        if not isinstance(items, list):
            raise ValueError("timers.json must contain an array.")
        for item in items:
            timer = self._validate(item, existing=item)
            timer["nextRunEpoch"] = self._next_epoch(timer)
            self._timers[timer["id"]] = timer

    @staticmethod
    def _public(timer):
        result = {key: value for key, value in timer.items() if key != "nextRunEpoch"}
        next_epoch = timer.get("nextRunEpoch")
        result["nextRunAt"] = datetime.fromtimestamp(next_epoch, timezone.utc).isoformat().replace("+00:00", "Z") if next_epoch is not None else None
        result["running"] = result.get("lastStatus") in ("queued", "running")
        return result

    def _save_locked(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        temporary = f"{self.path}.tmp"
        payload = [{key: value for key, value in timer.items() if key != "nextRunEpoch"} for timer in self._timers.values()]
        with open(temporary, "w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)
        os.replace(temporary, self.path)

    def list(self):
        self._refresh_statuses()
        with self._lock:
            return [self._public(timer) for timer in self._timers.values()]

    def replace_all(self, items):
        if not isinstance(items, list):
            raise ValueError("timers must be an array.")
        with self._lock:
            next_timers = {}
            for item in items:
                timer_id = str(item.get("id", ""))
                existing = self._timers.get(timer_id)
                timer = self._validate(item, existing=existing)
                if timer["id"] in next_timers:
                    raise ValueError(f"Duplicate timer id: {timer['id']}")
                schedule_changed = not existing or any(timer[key] != existing[key] for key in ("firstRunAt", "intervalSeconds", "enabled"))
                timer["nextRunEpoch"] = self._next_epoch(timer) if schedule_changed else existing.get("nextRunEpoch")
                next_timers[timer["id"]] = timer
            self._timers = next_timers
            self._save_locked()
            return [self._public(timer) for timer in self._timers.values()]

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = Thread(target=self._run_loop, name="timer-manager", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _refresh_statuses(self):
        if not self.status_callback:
            return
        with self._lock:
            targets = [(item["id"], item.get("lastRunId")) for item in self._timers.values() if item.get("lastRunId") and item.get("lastStatus") in ("queued", "running")]
        updates = []
        for timer_id, run_id in targets:
            try:
                state = self.status_callback(run_id)
            except Exception:
                continue
            updates.append((timer_id, state))
        if not updates:
            return
        with self._lock:
            changed = False
            for timer_id, state in updates:
                timer = self._timers.get(timer_id)
                if not timer:
                    continue
                timer["lastStatus"] = state.get("status")
                timer["lastDurationMs"] = state.get("timing", {}).get("totalElapsedMs")
                if state.get("status") == "error":
                    timer["lastError"] = "Concert run failed."
                changed = True
            if changed:
                self._save_locked()

    def _run_loop(self):
        while not self._stop_event.wait(self.poll_seconds):
            self._refresh_statuses()
            now = time.time()
            due = []
            with self._lock:
                for timer in self._timers.values():
                    next_epoch = timer.get("nextRunEpoch")
                    if timer["enabled"] and next_epoch is not None and next_epoch <= now:
                        timer["nextRunEpoch"] = self._next_epoch(timer, now=now)
                        due.append(dict(timer))
            for timer in due:
                self._execute(timer)

    def _execute(self, timer):
        run_at = _now_iso()
        try:
            result = self.run_callback(timer["concertName"], timer.get("params", {}))
            run_id = result.get("runId") if isinstance(result, dict) else None
            status = result.get("status", "queued") if isinstance(result, dict) else "queued"
            error = None
        except Exception as exc:
            run_id, status, error = None, "error", str(exc)
        with self._lock:
            current = self._timers.get(timer["id"])
            if current is None:
                return
            current.update({"lastRunAt": run_at, "lastRunId": run_id, "lastStatus": status, "lastDurationMs": None, "lastError": error, "updatedAt": _now_iso()})
            self._save_locked()
