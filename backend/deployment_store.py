import hashlib
import json
import os
import re
import shutil
from contextlib import contextmanager
from datetime import datetime
from threading import Lock
from uuid import uuid4

from concert_store import ConcertStore


class DeploymentMismatchError(ValueError):
    def __init__(self, message, mismatch_type, **details):
        self.detail = {
            "code": "DEPLOYMENT_MISMATCH",
            "mismatchType": mismatch_type,
            "message": message,
            **details,
        }
        super().__init__(message)


class VersionMismatchError(DeploymentMismatchError):
    def __init__(self, name, current_version, next_version):
        super().__init__(
            f"Production version mismatch: {current_version} -> {next_version}",
            "version",
            name=name,
            currentVersion=current_version,
            nextVersion=next_version,
        )


class DeploymentStore:
    VERSION_PATTERN = re.compile(r"[A-Za-z0-9.-]+")

    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.concerts_root = os.path.join(self.root, "concerts")
        self.rehearsals_root = os.path.join(self.root, "rehearsals")
        self.backups_root = os.path.join(self.root, "backups")
        self.transactions_root = os.path.join(self.rehearsals_root, ".deploy")
        for path in (self.concerts_root, self.rehearsals_root, self.backups_root, self.transactions_root):
            os.makedirs(path, exist_ok=True)
        self._sync_directories()
        self._guard = Lock()
        self._locks = {}

    def _lock_for(self, name):
        with self._guard:
            return self._locks.setdefault(name, Lock())

    @contextmanager
    def _lock_names(self, *names):
        locks = [self._lock_for(name) for name in sorted(set(names))]
        for lock in locks:
            lock.acquire()
        try:
            yield
        finally:
            for lock in reversed(locks):
                lock.release()

    @classmethod
    def validate_version(cls, version):
        value = str(version or "")
        if not value or not cls.VERSION_PATTERN.fullmatch(value):
            raise ValueError("Version may contain only letters, numbers, '.', and '-'.")
        return value

    @staticmethod
    def validate_name(name):
        value = str(name or "").replace("\\", "/").strip("/")
        if not value or ConcertStore.safe_path_name(value) != value:
            raise ValueError(f"Invalid Concert path: {name}")
        return value

    @staticmethod
    def _path(root, relative):
        path = os.path.abspath(os.path.join(root, relative))
        if os.path.commonpath([os.path.abspath(root), path]) != os.path.abspath(root):
            raise ValueError(f"Invalid relative path: {relative}")
        return path

    def _concert_path(self, root, name):
        return self._path(root, f"{self.validate_name(name)}.concert")

    def _sync_directories(self):
        expected = {""}
        for current_root, folders, _ in os.walk(self.concerts_root):
            folders[:] = [folder for folder in folders if not folder.startswith(".")]
            relative = os.path.relpath(current_root, self.concerts_root)
            if relative != ".":
                expected.add(relative.replace(os.sep, "/"))
        for root in (self.rehearsals_root, self.backups_root):
            for relative in expected:
                os.makedirs(self._path(root, relative), exist_ok=True)
            for current_root, folders, _ in os.walk(root, topdown=False):
                folders[:] = [folder for folder in folders if not folder.startswith(".")]
                relative = os.path.relpath(current_root, root).replace(os.sep, "/")
                if any(part.startswith(".") for part in relative.split("/")):
                    continue
                if relative != "." and relative not in expected:
                    try:
                        os.rmdir(current_root)
                    except OSError:
                        pass
        return sorted(expected)

    def _validate_target_directory(self, name):
        directory = os.path.dirname(self.validate_name(name))
        if directory and not os.path.isdir(self._path(self.concerts_root, directory)):
            raise FileNotFoundError(f"Concert directory not found: {directory}")

    @staticmethod
    def _payload_bytes(payload):
        return json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")

    @staticmethod
    def _checksum(data):
        return hashlib.sha256(data).hexdigest()

    @staticmethod
    def _read(path):
        with open(path, "r", encoding="utf-8") as file:
            return json.load(file)

    @staticmethod
    def _write(path, data):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temporary = f"{path}.{uuid4().hex}.tmp"
        try:
            with open(temporary, "wb") as file:
                file.write(data)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def _rename_payload(self, path, name):
        stat = os.stat(path)
        payload = self._read(path)
        payload["name"] = os.path.basename(name)
        self._write(path, self._payload_bytes(payload))
        os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))

    @staticmethod
    def _prune_empty(root, path):
        root = os.path.abspath(root)
        current = os.path.abspath(path)
        while current != root and os.path.commonpath([root, current]) == root:
            try:
                os.rmdir(current)
            except OSError:
                break
            current = os.path.dirname(current)

    def validate_payload(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("Concert payload must be an object.")
        name = self.validate_name(payload.get("name"))
        if os.path.basename(name) != name:
            raise ValueError("Concert name must not contain a directory.")
        concert_id = ConcertStore.validate_id(payload.get("concertId"))
        version = self.validate_version(payload.get("version"))
        if not isinstance(payload.get("nodes"), list) or not isinstance(payload.get("edges"), list):
            raise ValueError("Concert payload requires nodes and edges arrays.")
        return {**payload, "concertId": concert_id, "name": name, "version": version}

    def _rehearsal_with_basename(self, basename):
        for current_root, folders, files in os.walk(self.rehearsals_root):
            folders[:] = [folder for folder in folders if not folder.startswith(".")]
            for file_name in files:
                if file_name == f"{basename}.concert":
                    relative = os.path.relpath(os.path.join(current_root, file_name), self.rehearsals_root)
                    return relative[:-8].replace(os.sep, "/")
        if os.path.isdir(self.transactions_root):
            for transaction_id in os.listdir(self.transactions_root):
                manifest_path = os.path.join(self.transactions_root, transaction_id, "manifest.json")
                if not os.path.isfile(manifest_path):
                    continue
                manifest = self._read(manifest_path)
                if os.path.basename(manifest.get("name", "")) == basename:
                    return manifest["name"]
        return None

    def _production_with_basename(self, basename):
        matches = []
        for current_root, folders, files in os.walk(self.concerts_root):
            folders[:] = [folder for folder in folders if not folder.startswith(".")]
            if f"{basename}.concert" in files:
                path = os.path.join(current_root, f"{basename}.concert")
                matches.append(os.path.relpath(path, self.concerts_root).replace(os.sep, "/")[:-8])
        if len(matches) > 1:
            raise ValueError(f"Multiple Production Concerts have the same filename: {basename}")
        return matches[0] if matches else None

    def _backup_ids_with_basename(self, basename):
        concert_ids = set()
        prefix = f"{basename}@"
        for current_root, _, files in os.walk(self.backups_root):
            for file_name in files:
                if file_name.startswith(prefix) and file_name.endswith(".concert"):
                    concert_ids.add(ConcertStore.validate_id(self._read(os.path.join(current_root, file_name)).get("concertId")))
        return concert_ids

    def prepare(self, transaction_id, payload, source_name=None, deployment_name=None, allow_mismatch=False):
        transaction_id = str(transaction_id or "")
        if not re.fullmatch(r"[A-Za-z0-9-]+", transaction_id):
            raise ValueError("Invalid deployment transaction ID.")
        payload = self.validate_payload(payload)
        name = self.validate_name(deployment_name or payload["name"])
        self._validate_target_directory(name)
        source_name = self.validate_name(source_name or name)
        if os.path.basename(source_name) != os.path.basename(name):
            raise ValueError("Deployment may change only the Concert directory, not its filename.")
        production_name = self._production_with_basename(os.path.basename(name))
        if production_name:
            if name != production_name:
                raise ValueError(f"Existing Production must be deployed to its current directory: {production_name}")
            current_version = self._version(self._concert_path(self.concerts_root, production_name))
            current_id = self._read(self._concert_path(self.concerts_root, production_name))["concertId"]
            if current_id != payload["concertId"] and not allow_mismatch:
                raise DeploymentMismatchError(
                    f"Production concertId mismatch: {current_id}",
                    "productionConcertId",
                    currentConcertId=current_id,
                    nextConcertId=payload["concertId"],
                )
            if current_version != payload["version"] and not allow_mismatch:
                raise VersionMismatchError(production_name, current_version, payload["version"])
            source_name = production_name
        else:
            try:
                owner = ConcertStore(self.concerts_root).name_for_id(payload["concertId"])
            except FileNotFoundError:
                owner = None
            if owner:
                raise ValueError(f"concertId already belongs to another Concert: {owner}")
            backup_ids = self._backup_ids_with_basename(os.path.basename(name))
            if backup_ids and backup_ids != {payload["concertId"]} and not allow_mismatch:
                backup_id_text = ", ".join(sorted(backup_ids))
                raise DeploymentMismatchError(
                    f"Backup concertId mismatch: {backup_id_text}",
                    "backupConcertId",
                    backupConcertIds=sorted(backup_ids),
                    nextConcertId=payload["concertId"],
                )
        target = self._concert_path(self.rehearsals_root, name)
        rehearsal_key = f"rehearsal:{os.path.basename(name)}"
        with self._lock_names(source_name, name, rehearsal_key):
            rehearsal = self._rehearsal_with_basename(os.path.basename(name))
            if rehearsal:
                raise FileExistsError(f"Rehearsal already exists: {rehearsal}")
            transaction_root = self._path(self.transactions_root, transaction_id)
            staged = self._concert_path(transaction_root, name)
            manifest_path = os.path.join(transaction_root, "manifest.json")
            if os.path.exists(manifest_path):
                raise FileExistsError(f"Deployment transaction already exists: {transaction_id}")
            data = self._payload_bytes(payload)
            try:
                self._write(staged, data)
                self._write(manifest_path, self._payload_bytes({
                    "transactionId": transaction_id,
                    "name": name,
                    "sourceName": source_name,
                    "checksum": self._checksum(data),
                    "state": "prepared",
                }))
            except Exception:
                shutil.rmtree(transaction_root, ignore_errors=True)
                raise
        return {"transactionId": transaction_id, "name": name, "checksum": self._checksum(data)}

    def _manifest(self, transaction_id):
        path = self._path(self.transactions_root, os.path.join(str(transaction_id), "manifest.json"))
        if not os.path.exists(path):
            raise FileNotFoundError(f"Deployment transaction not found: {transaction_id}")
        return path, self._read(path)

    def commit(self, transaction_id):
        manifest_path, manifest = self._manifest(transaction_id)
        name = manifest["name"]
        source_name = manifest["sourceName"]
        rehearsal_key = f"rehearsal:{os.path.basename(name)}"
        with self._lock_names(source_name, name, rehearsal_key):
            if manifest["state"] != "prepared":
                raise ValueError(f"Deployment transaction is not prepared: {transaction_id}")
            target = self._concert_path(self.rehearsals_root, name)
            if os.path.exists(target):
                raise FileExistsError(f"Rehearsal already exists: {name}")
            staged = self._concert_path(os.path.dirname(manifest_path), name)
            try:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                os.replace(staged, target)
                manifest["state"] = "committed"
                self._write(manifest_path, self._payload_bytes(manifest))
            except Exception:
                if os.path.exists(target):
                    os.makedirs(os.path.dirname(staged), exist_ok=True)
                    os.replace(target, staged)
                raise
        return manifest

    def compensate(self, transaction_id):
        manifest_path, manifest = self._manifest(transaction_id)
        name = manifest["name"]
        source_name = manifest["sourceName"]
        rehearsal_key = f"rehearsal:{os.path.basename(name)}"
        with self._lock_names(source_name, name, rehearsal_key):
            if manifest["state"] == "committed":
                target = self._concert_path(self.rehearsals_root, name)
                if os.path.exists(target):
                    with open(target, "rb") as file:
                        checksum = self._checksum(file.read())
                    if checksum != manifest["checksum"]:
                        raise ValueError(f"Committed rehearsal changed after deployment: {name}")
                    os.unlink(target)
            shutil.rmtree(os.path.dirname(manifest_path), ignore_errors=True)
        self._sync_directories()
        return {"compensated": True, "transactionId": transaction_id}

    def finalize(self, transaction_id):
        manifest_path, manifest = self._manifest(transaction_id)
        if manifest["state"] != "committed":
            raise ValueError(f"Deployment transaction is not committed: {transaction_id}")
        shutil.rmtree(os.path.dirname(manifest_path), ignore_errors=True)
        self._sync_directories()
        return {"finalized": True, "transactionId": transaction_id}

    def deploy(self, payload, source_name=None, deployment_name=None, allow_mismatch=False):
        transaction_id = str(uuid4())
        self.prepare(
            transaction_id,
            payload,
            source_name=source_name,
            deployment_name=deployment_name,
            allow_mismatch=allow_mismatch,
        )
        try:
            result = self.commit(transaction_id)
            self.finalize(transaction_id)
            return result
        except Exception:
            self.compensate(transaction_id)
            raise

    def _version(self, path):
        return self.validate_version(self._read(path).get("version"))

    def _backup_path(self, name, version):
        folder, base = os.path.split(self.validate_name(name))
        while True:
            time_key = datetime.now().strftime("%Y%m%d%H%M%S%f")
            relative = os.path.join(folder, f"{base}@{version}@{time_key}.concert")
            path = self._path(self.backups_root, relative)
            if not os.path.exists(path):
                return path

    def promote(self, name):
        name = self.validate_name(name)
        rehearsal = self._concert_path(self.rehearsals_root, name)
        production = self._concert_path(self.concerts_root, name)
        with self._lock_for(name):
            if not os.path.exists(rehearsal):
                raise FileNotFoundError(f"Rehearsal not found: {name}")
            self._version(rehearsal)
            backup = None
            if os.path.exists(production):
                backup = self._backup_path(name, self._version(production))
                os.makedirs(os.path.dirname(backup), exist_ok=True)
                os.replace(production, backup)
            try:
                os.makedirs(os.path.dirname(production), exist_ok=True)
                os.replace(rehearsal, production)
                os.utime(production, None)
            except Exception:
                if backup and os.path.exists(backup):
                    os.replace(backup, production)
                raise
        self._sync_directories()
        return {"promoted": True, "name": name}

    def rollback(self, backup_path):
        relative = str(backup_path or "").replace("\\", "/").strip("/")
        backup = self._path(self.backups_root, relative)
        if not os.path.isfile(backup) or not relative.endswith(".concert"):
            raise FileNotFoundError(f"Backup not found: {backup_path}")
        folder, file_name = os.path.split(relative)
        parts = file_name[:-8].rsplit("@", 2)
        if len(parts) != 3 or not parts[0]:
            raise ValueError(f"Invalid backup filename: {file_name}")
        name = self.validate_name("/".join(part for part in (folder, parts[0]) if part))
        production = self._concert_path(self.concerts_root, name)
        with self._lock_for(name):
            self._version(backup)
            current_backup = None
            if os.path.exists(production):
                current_backup = self._backup_path(name, self._version(production))
                os.makedirs(os.path.dirname(current_backup), exist_ok=True)
                os.replace(production, current_backup)
                os.utime(current_backup, None)
            try:
                os.makedirs(os.path.dirname(production), exist_ok=True)
                os.replace(backup, production)
                os.utime(production, None)
            except Exception:
                if current_backup and os.path.exists(current_backup):
                    os.replace(current_backup, production)
                raise
        self._sync_directories()
        return {"rolledBack": True, "name": name}

    def move(self, name, directory):
        name = self.validate_name(name)
        directory = self.validate_directory(directory)
        self._validate_target_directory("/".join(part for part in (directory, os.path.basename(name)) if part))
        target_name = "/".join(part for part in (directory, os.path.basename(name)) if part)
        if target_name == name:
            return {"moved": True, "name": name}
        if self._rehearsal_with_basename(os.path.basename(name)):
            raise FileExistsError(f"Rehearsal exists for Concert: {os.path.basename(name)}")
        production = self._concert_path(self.concerts_root, name)
        target = self._concert_path(self.concerts_root, target_name)
        if not os.path.isfile(production):
            raise FileNotFoundError(f"Production Concert not found: {name}")
        if os.path.exists(target):
            raise FileExistsError(f"Target Concert already exists: {target_name}")
        source_folder, base = os.path.split(name)
        backup_files = []
        backup_root = self._path(self.backups_root, source_folder)
        if os.path.isdir(backup_root):
            backup_files = [file_name for file_name in os.listdir(backup_root) if file_name.startswith(f"{base}@") and file_name.endswith(".concert")]
        moves = [(production, target)] + [
            (
                self._path(self.backups_root, "/".join(part for part in (source_folder, file_name) if part)),
                self._path(self.backups_root, "/".join(part for part in (directory, file_name) if part)),
            )
            for file_name in backup_files
        ]
        with self._lock_names(name, target_name):
            completed = []
            try:
                for source, destination in moves:
                    if os.path.exists(destination):
                        raise FileExistsError(f"Target file already exists: {destination}")
                    os.makedirs(os.path.dirname(destination), exist_ok=True)
                    os.replace(source, destination)
                    self._rename_payload(destination, target_name)
                    completed.append((source, destination))
            except Exception:
                for source, destination in reversed(completed):
                    os.replace(destination, source)
                    self._rename_payload(source, name)
                raise
        self._prune_empty(self.concerts_root, os.path.dirname(production))
        self._sync_directories()
        return {"moved": True, "name": target_name}

    def delete(self, kind, path):
        roots = {
            "concert": self.concerts_root,
            "rehearsal": self.rehearsals_root,
            "backup": self.backups_root,
        }
        if kind not in roots:
            raise ValueError(f"Invalid deployment kind: {kind}")
        relative = str(path or "").replace("\\", "/").strip("/")
        if not relative.endswith(".concert") or any(part in {"", ".", ".."} for part in relative.split("/")):
            raise ValueError(f"Invalid deployment path: {path}")
        target = self._path(roots[kind], relative)
        with self._lock_for(f"{kind}:{relative}"):
            if not os.path.isfile(target):
                raise FileNotFoundError(f"Deployment file not found: {path}")
            os.unlink(target)
        self._sync_directories()
        return {"deleted": True, "kind": kind, "path": relative}

    def load_file(self, kind, path):
        roots = {"concert": self.concerts_root, "rehearsal": self.rehearsals_root, "backup": self.backups_root}
        if kind not in roots:
            raise ValueError(f"Invalid deployment kind: {kind}")
        relative = str(path or "").replace("\\", "/").strip("/")
        if not relative.endswith(".concert") or any(part in {"", ".", ".."} for part in relative.split("/")):
            raise ValueError(f"Invalid deployment path: {path}")
        target = self._path(roots[kind], relative)
        if not os.path.isfile(target):
            raise FileNotFoundError(f"Deployment file not found: {path}")
        return self._read(target)

    def _list_root(self, root, kind):
        items = []
        for current_root, folders, files in os.walk(root):
            folders[:] = [folder for folder in folders if not folder.startswith(".")]
            for file_name in files:
                if not file_name.endswith(".concert"):
                    continue
                path = os.path.join(current_root, file_name)
                relative = os.path.relpath(path, root).replace(os.sep, "/")
                payload = self._read(path)
                item = {
                    "concertId": ConcertStore.validate_id(payload.get("concertId")),
                    "kind": kind,
                    "path": relative,
                    "version": payload.get("version"),
                    "updatedAt": os.path.getmtime(path),
                    "timeKey": datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y%m%d%H%M%S%f"),
                }
                if kind == "backup":
                    folder, base = os.path.split(relative[:-8])
                    original, version, time_key = base.rsplit("@", 2)
                    item.update({
                        "name": "/".join(part for part in (folder, original) if part),
                        "backupPath": relative,
                        "backupVersion": version,
                        "updatedAt": datetime.strptime(
                            time_key, "%Y%m%d%H%M%S%f"
                        ).timestamp(),
                        "timeKey": time_key,
                    })
                else:
                    item["name"] = relative[:-8]
                items.append(item)
        return sorted(items, key=lambda item: item["path"])

    @staticmethod
    def validate_directory(directory):
        value = str(directory or "").replace("\\", "/").strip("/")
        if not value:
            return ""
        if any(
            not part
            or part in {".", ".."}
            or not re.fullmatch(r"[A-Za-z0-9_.-]+", part)
            for part in value.split("/")
        ):
            raise ValueError(f"Invalid Concert directory: {directory}")
        return value

    def directories(self):
        return self._sync_directories()

    def create_directory(self, directory):
        directory = self.validate_directory(directory)
        if not directory:
            raise ValueError("Directory name is required.")
        for root in (self.concerts_root, self.rehearsals_root, self.backups_root):
            os.makedirs(self._path(root, directory), exist_ok=True)
        return {"directory": directory}

    def delete_directory(self, directory):
        directory = self.validate_directory(directory)
        if not directory:
            raise ValueError("Root Concert directory cannot be deleted.")
        paths = [self._path(root, directory) for root in (
            self.concerts_root,
            self.rehearsals_root,
            self.backups_root,
        )]
        if not os.path.isdir(paths[0]):
            raise FileNotFoundError(f"Concert directory not found: {directory}")
        if any(os.path.isdir(path) and os.listdir(path) for path in paths):
            raise ValueError(f"Concert directory is not empty: {directory}")
        for path in paths:
            if os.path.isdir(path):
                os.rmdir(path)
        return {"deleted": True, "directory": directory}

    def list(self):
        self._sync_directories()
        return {
            "concerts": self._list_root(self.concerts_root, "concert"),
            "rehearsals": self._list_root(self.rehearsals_root, "rehearsal"),
            "backups": self._list_root(self.backups_root, "backup"),
        }
