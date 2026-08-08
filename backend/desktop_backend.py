import json
import os
import sys
from pathlib import Path


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
            "oracle": {
                "poolMin": 1,
                "poolMax": 4,
                "poolIncrement": 1,
                "writeBatchSize": 1000,
            },
            "executor": {
                "workers": 3,
                "timeoutSeconds": 60,
            },
        },
        "servers.json": [
            {"name": "Local", "host": "localhost", "port": 8000},
        ],
        "connections.json": {"connections": []},
        "connection_schema_cache.json": {},
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
    data_root = _initialize_data_directory()
    local_port = _local_server_port(data_root)

    import uvicorn
    from fastapi import Header, HTTPException
    from main import app

    shutdown_token = os.environ.get("METRONOME_SHUTDOWN_TOKEN")
    server = uvicorn.Server(
        uvicorn.Config(app, host="0.0.0.0", port=local_port, log_level="info")
    )

    def require_desktop_token(token):
        if not shutdown_token or token != shutdown_token:
            raise HTTPException(status_code=403, detail="Invalid desktop token.")

    @app.get("/desktop/health", include_in_schema=False)
    def desktop_health(x_metronome_token: str = Header(default="")):
        require_desktop_token(x_metronome_token)
        return {"status": "ok"}

    @app.post("/desktop/shutdown", include_in_schema=False)
    def desktop_shutdown(x_metronome_token: str = Header(default="")):
        require_desktop_token(x_metronome_token)
        server.should_exit = True
        return {"status": "stopping"}

    server.run()
