import json
import os
from functools import lru_cache


BACKEND_ROOT = os.environ.get(
    "METRONOME_DATA_DIR",
    os.path.dirname(os.path.abspath(__file__)),
)
CONFIG_PATH = os.path.join(BACKEND_ROOT, "config.json")

DEFAULT_CONFIG = {
    "backend": {
        "consoleMode": False,
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
    },
}


def _deep_merge(base, override):
    result = dict(base)
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge(result[key], value)
        else:
            result[key] = value
    return result


@lru_cache(maxsize=1)
def load_config():
    if not os.path.exists(CONFIG_PATH):
        return DEFAULT_CONFIG
    with open(CONFIG_PATH, "r", encoding="utf-8") as file:
        payload = json.load(file)
    return _deep_merge(DEFAULT_CONFIG, payload)


def config_int(section, key):
    value = load_config().get(section, {}).get(key, DEFAULT_CONFIG[section][key])
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"Invalid integer config: {section}.{key}={value!r}") from exc
