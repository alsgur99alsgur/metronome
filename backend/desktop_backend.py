import json
import os
from pathlib import Path


def _initialize_data_directory():
    data_root = Path(os.environ["METRONOME_DATA_DIR"])
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


if __name__ == "__main__":
    _initialize_data_directory()

    import uvicorn
    from main import app

    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
