import json


class ServerManager:
    def __init__(self, path):
        with open(path, "r", encoding="utf-8") as file:
            items = json.load(file)
        if not isinstance(items, list) or not items:
            raise ValueError("servers.json must contain a non-empty array.")

        self._servers = {}
        for item in items:
            name = str(item.get("name", "")).strip()
            host = str(item.get("host", "")).strip()
            port = int(item.get("port", 0))
            if not name or name in self._servers:
                raise ValueError(f"Invalid or duplicate server name: {name}")
            if not host or "/" in host:
                raise ValueError(f"Invalid host for server: {name}")
            if not 1 <= port <= 65535:
                raise ValueError(f"Invalid port for server: {name}")
            self._servers[name] = {"name": name, "host": host, "port": port}

    @property
    def primary(self):
        return next(iter(self._servers.values()))

    def list(self):
        return list(self._servers.values())

    def get(self, name):
        try:
            return self._servers[str(name)]
        except KeyError as exc:
            raise KeyError(f"Server not found: {name}") from exc
