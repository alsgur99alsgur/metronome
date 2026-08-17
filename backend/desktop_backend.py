import ctypes
import json
import multiprocessing
import os
import sys
from pathlib import Path
from threading import Thread
import time


def _initialize_data_directory():
    default_root = (
        Path(sys.executable).parent
        if getattr(sys, "frozen", False)
        else Path(__file__).parent
    )
    data_root = Path(os.environ.setdefault("METRONOME_DATA_DIR", str(default_root)))
    data_root.mkdir(parents=True, exist_ok=True)

    defaults = {
        "config.json": {
            "backend": {
                "consoleMode": True,
            },
            "oracle": {
                "poolMin": 1,
                "poolMax": 4,
                "poolIncrement": 1,
                "writeBatchSize": 1000,
            },
            "executor": {
                "workers": 3,
                "timeoutSeconds": 60,
                "nodeLogLimitKb": 1024,
            },
            "storage": {
                "retentionDays": 7,
                "cacheMemoryLimitMb": 64,
            },
        },
        "servers.json": [
            {"name": "Local", "host": "localhost", "port": 8000},
        ],
        "connections.json": {"connections": []},
        "timers.json": [],
    }
    for file_name, payload in defaults.items():
        path = data_root / file_name
        if not path.exists():
            path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
    return data_root


def _configure_console(data_root):
    from app_config import load_config

    console_mode = load_config().get("backend", {}).get("consoleMode", True)
    if type(console_mode) is not bool:
        raise ValueError("config.json backend.consoleMode must be a boolean.")
    if sys.platform != "win32":
        return
    kernel32 = ctypes.windll.kernel32
    user32 = ctypes.windll.user32
    console_window = kernel32.GetConsoleWindow()
    if not console_window:
        if not kernel32.AllocConsole():
            raise OSError("Failed to allocate the backend console.")
        console_window = kernel32.GetConsoleWindow()
    if sys.stdin is None:
        sys.stdin = open("CONIN$", "r", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = open("CONOUT$", "w", encoding="utf-8", buffering=1)
    if sys.stderr is None:
        sys.stderr = open("CONOUT$", "w", encoding="utf-8", buffering=1)
    if console_window:
        user32.ShowWindow(console_window, 5 if console_mode else 0)


def _watch_console_mode(data_root):
    if sys.platform != "win32":
        return

    def watch():
        previous = None
        while True:
            try:
                from app_config import load_config

                current = load_config().get("backend", {}).get("consoleMode", True)
                if current != previous:
                    _configure_console(data_root)
                    previous = current
            except Exception as exc:
                print(f"Console configuration reload failed: {exc}")
            time.sleep(1)

    Thread(target=watch, name="console-config", daemon=True).start()


def _local_server_port(data_root):
    servers = json.loads((data_root / "servers.json").read_text(encoding="utf-8"))
    if not isinstance(servers, list):
        raise ValueError("servers.json must contain an array.")
    local_servers = [item for item in servers if item.get("name") == "Local"]
    if len(local_servers) != 1:
        raise ValueError("servers.json must contain exactly one Local server.")
    port = local_servers[0].get("port")
    if type(port) is not int or not 1 <= port <= 65535:
        raise ValueError("Local server port must be an integer from 1 to 65535.")
    return port


if __name__ == "__main__":
    multiprocessing.freeze_support()
    data_root = _initialize_data_directory()
    _configure_console(data_root)
    _watch_console_mode(data_root)
    local_port = _local_server_port(data_root)

    import uvicorn
    from main import app

    server = uvicorn.Server(
        uvicorn.Config(app, host="0.0.0.0", port=local_port, log_level="info")
    )
    server.run()
