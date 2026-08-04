import json
import os
import re
from uuid import UUID


class ConcertStore:
    def __init__(self, path="./concerts"):
        self.path = path
        os.makedirs(self.path, exist_ok=True)

    @staticmethod
    def safe_name(name):
        safe = re.sub(r"[^a-zA-Z0-9_.-]+", "_", name or "").strip("_")
        return safe or "untitled_concert"

    @classmethod
    def safe_path_name(cls, name):
        text = str(name or "").replace("\\", "/").strip("/")
        parts = [
            cls.safe_name(part)
            for part in text.split("/")
            if part and part not in (".", "..")
        ]
        return "/".join(parts) or "untitled_concert"

    def _path_for(self, name):
        concert_name = self.safe_path_name(name)
        path = os.path.abspath(os.path.join(self.path, f"{concert_name}.concert"))
        root = os.path.abspath(self.path)
        if os.path.commonpath([root, path]) != root:
            raise ValueError(f"Invalid Concert path: {name}")
        return path

    @staticmethod
    def validate_id(concert_id):
        try:
            return str(UUID(str(concert_id)))
        except (ValueError, TypeError, AttributeError) as exc:
            raise ValueError(f"Invalid concertId: {concert_id}") from exc

    def _id_registry(self):
        registry = {}
        for root, _, files in os.walk(self.path):
            for file_name in files:
                if not file_name.endswith(".concert"):
                    continue
                path = os.path.join(root, file_name)
                with open(path, "r", encoding="utf-8") as file:
                    payload = json.load(file)
                concert_id = self.validate_id(payload.get("concertId"))
                name = os.path.relpath(path, self.path).replace(os.sep, "/")[:-8]
                if concert_id in registry:
                    raise ValueError(f"Duplicate concertId: {concert_id}")
                registry[concert_id] = name
        return registry

    def name_for_id(self, concert_id):
        concert_id = self.validate_id(concert_id)
        try:
            return self._id_registry()[concert_id]
        except KeyError as exc:
            raise FileNotFoundError(f"Concert not found for concertId: {concert_id}") from exc

    def load_by_id(self, concert_id):
        return self.load(self.name_for_id(concert_id))

    @staticmethod
    def _clean_node_for_save(node):
        data = dict(node["data"])
        for key in (
            "runRows",
            "runDurationMs",
            "runLoopIterations",
            "isConnectMode",
            "outputColumns",
            "schemaError",
            "status",
        ):
            data.pop(key, None)
        next_node = dict(node)
        for key in ("width", "height", "selected", "dragging", "positionAbsolute"):
            next_node.pop(key, None)
        next_node["data"] = data
        return next_node

    @staticmethod
    def _clean_edge_for_save(edge):
        next_edge = dict(edge)
        for key in ("type", "markerEnd", "sourceHandle", "targetHandle"):
            next_edge.pop(key, None)
        data = dict(next_edge.get("data") or {})
        data.pop("columns", None)
        next_edge["data"] = data
        return next_edge

    def save(self, concert_id, name, nodes, edges, global_variables=None, input_variables=None, version=""):
        concert_id = self.validate_id(concert_id)
        registry = self._id_registry()
        concert_name = self.safe_path_name(name)
        if os.path.basename(concert_name) != concert_name:
            raise ValueError("Concert name must not contain a directory.")
        existing_name = registry.get(concert_id)
        if existing_name and existing_name != concert_name:
            raise ValueError(f"concertId already belongs to another Concert: {existing_name}")
        target = self._path_for(concert_name)
        if os.path.exists(target) and self.load(concert_name).get("concertId") != concert_id:
            raise ValueError(f"Concert name belongs to another concertId: {concert_name}")
        payload = {
            "concertId": concert_id,
            "version": version,
            "name": concert_name,
            "nodes": [self._clean_node_for_save(node) for node in nodes],
            "edges": [self._clean_edge_for_save(edge) for edge in edges],
            "globalVariables": global_variables or [],
            "inputVariables": input_variables or [],
        }
        path = target
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as file:
            json.dump(payload, file, indent=2)
        return payload

    def load(self, name):
        path = self._path_for(name)
        if not os.path.exists(path):
            raise FileNotFoundError(f"Concert not found: {name}")
        with open(path, "r", encoding="utf-8") as file:
            return json.load(file)

    def list(self):
        concerts = []
        for root, _, files in os.walk(self.path):
            for file_name in sorted(files):
                if not file_name.endswith(".concert"):
                    continue
                path = os.path.join(root, file_name)
                relative = os.path.relpath(path, self.path)
                concert_name = relative[:-8].replace(os.sep, "/")
                concerts.append(
                    {
                        "concertId": self.validate_id(self.load(concert_name).get("concertId")),
                        "name": concert_name,
                        "path": relative.replace(os.sep, "/"),
                        "folder": "" if "/" not in concert_name else concert_name.rsplit("/", 1)[0],
                        "updatedAt": os.path.getmtime(path),
                    }
                )
        concerts.sort(key=lambda item: item["name"])
        return concerts
