import json


class ServerManager:
    def __init__(self, path):
        self._path = path

    def _read_servers(self):
        with open(self._path, "r", encoding="utf-8") as file:
            items = json.load(file)
        if not isinstance(items, list) or not items:
            raise ValueError("servers.json must contain a non-empty array.")

        servers = {}
        for item in items:
            name = str(item.get("name", "")).strip()
            host = str(item.get("host", "")).strip()
            port = int(item.get("port", 0))
            if not name or name in servers:
                raise ValueError(f"Invalid or duplicate server name: {name}")
            if not host or "/" in host:
                raise ValueError(f"Invalid host for server: {name}")
            if not 1 <= port <= 65535:
                raise ValueError(f"Invalid port for server: {name}")
            servers[name] = {"name": name, "host": host, "port": port}
        if "Local" not in servers:
            raise ValueError("servers.json must contain a Local server.")
        return servers

    @property
    def primary(self):
        return self._read_servers()["Local"]

    def list(self):
        return list(self._read_servers().values())

    def get(self, name):
        try:
            return self._read_servers()[str(name)]
        except KeyError as exc:
            raise KeyError(f"Server not found: {name}") from exc
