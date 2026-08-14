import hashlib
import json
import os
import re
from dataclasses import dataclass
from threading import Lock

import pandas as pd

from app_config import config_int


BACKEND_ROOT = os.environ.get(
    "METRONOME_DATA_DIR",
    os.path.dirname(os.path.abspath(__file__)),
)
CONNECTIONS_PATH = os.path.join(BACKEND_ROOT, "connections.json")
SCHEMA_CACHE_PATH = os.path.join(BACKEND_ROOT, "connection_schema_cache.json")
_BIND_PATTERN = re.compile(r"(?<!:):([A-Za-z_][A-Za-z0-9_]*)")
_SQL_COMMENT_OR_STRING_PATTERN = re.compile(r"(--[^\n]*|/\*.*?\*/|'(?:''|[^'])*')", re.DOTALL)
_POOL_LOCK = Lock()
_SCHEMA_LOCK = Lock()
_ORACLE_CLIENT_LOCK = Lock()
_ORACLE_CLIENT_INITIALIZED = False
_POOLS = {}


def close_all_pools():
    with _POOL_LOCK:
        pools = list(_POOLS.values())
        _POOLS.clear()
    for pool in pools:
        try:
            pool.close(force=True)
        except Exception:
            pass


@dataclass
class OracleConnection:
    name: str
    user: str
    password: str
    dsn: str
    enable: bool
    pm: bool


class OracleUnavailable(Exception):
    pass


class OracleConnectionFailure(OracleUnavailable):
    pass


def _load_oracledb():
    try:
        import oracledb  # type: ignore
    except ModuleNotFoundError as exc:
        raise OracleUnavailable("python-oracledb is not installed.") from exc
    _initialize_oracle_client(oracledb)
    return oracledb


def _initialize_oracle_client(oracledb):
    global _ORACLE_CLIENT_INITIALIZED
    if _ORACLE_CLIENT_INITIALIZED:
        return
    with _ORACLE_CLIENT_LOCK:
        if _ORACLE_CLIENT_INITIALIZED:
            return
        lib_dir = os.path.join(BACKEND_ROOT, "oracle-client")
        if os.path.isfile(os.path.join(lib_dir, "oci.dll")):
            oracledb.init_oracle_client(lib_dir=lib_dir)
        _ORACLE_CLIENT_INITIALIZED = True


def _read_connections(path=None):
    path = path or CONNECTIONS_PATH
    if not os.path.exists(path):
        raise OracleUnavailable(f"Connection registry not found: {path}")
    with open(path, "r", encoding="utf-8") as file:
        payload = json.load(file)
    items = payload.get("connections")
    if not isinstance(items, list):
        raise ValueError("connections.json must contain a connections array.")
    names = set()
    result = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Each connection must be an object.")
        name = str(item.get("name", "")).strip()
        user = str(item.get("user", "")).strip()
        password = item.get("password")
        dsn = str(item.get("dsn", "")).strip()
        if not name or name in names:
            raise ValueError(f"Invalid or duplicate connection name: {name}")
        if not user or not isinstance(password, str) or not password or not dsn:
            raise ValueError(f"Connection requires user, password, and dsn: {name}")
        if not isinstance(item.get("enable"), bool) or not isinstance(item.get("pm"), bool):
            raise ValueError(f"Connection requires boolean enable and pm fields: {name}")
        names.add(name)
        result.append({"name": name, "user": user, "password": password, "dsn": dsn, "enable": item["enable"], "pm": item["pm"]})
    return result


def _write_json_atomic(path, payload):
    temporary = f"{path}.tmp"
    with open(temporary, "w", encoding="utf-8") as file:
        json.dump(payload, file, ensure_ascii=False, indent=2)
    os.replace(temporary, path)


def list_admin_connections():
    return [{"name": item["name"], "user": item["user"], "dsn": item["dsn"], "enable": item["enable"], "pm": item["pm"], "passwordSet": True} for item in _read_connections()]


def list_connection_names(path=None):
    return sorted(item["name"] for item in _read_connections(path) if item["enable"])


def load_connection(connection_name, path=None, require_enabled=True):
    if not connection_name:
        raise OracleUnavailable("DB node has no Oracle connection selected.")
    for item in _read_connections(path):
        if item["name"] == connection_name:
            if require_enabled and not item["enable"]:
                raise OracleUnavailable(f"Oracle connection is disabled: {connection_name}")
            return OracleConnection(**item)
    raise OracleUnavailable(f"Oracle connection not found: {connection_name}")


def _pool_key(connection):
    return (connection.name, connection.user, connection.password, connection.dsn)


def _close_pools(connection_names):
    names = set(connection_names)
    with _POOL_LOCK:
        targets = [key for key in _POOLS if key[0] in names]
        pools = [_POOLS.pop(key) for key in targets]
    for pool in pools:
        try:
            pool.close(force=True)
        except Exception:
            pass


def _read_schema_cache():
    if not os.path.exists(SCHEMA_CACHE_PATH):
        return {}
    with open(SCHEMA_CACHE_PATH, "r", encoding="utf-8") as file:
        payload = json.load(file)
    if not isinstance(payload, dict):
        raise ValueError("connection_schema_cache.json must contain an object.")
    return payload


def _normalize_sql(sql):
    return (sql or "").strip().rstrip(";")


def _schema_key(connection_name, sql):
    digest = hashlib.sha256(_normalize_sql(sql).encode("utf-8")).hexdigest()
    return f"{connection_name}:{digest}"


def _save_schema(connection_name, sql, columns):
    with _SCHEMA_LOCK:
        payload = _read_schema_cache()
        payload[_schema_key(connection_name, sql)] = {"connection": connection_name, "sqlHash": _schema_key(connection_name, sql).split(":", 1)[1], "columns": columns}
        _write_json_atomic(SCHEMA_CACHE_PATH, payload)


def _load_schema(connection_name, sql):
    with _SCHEMA_LOCK:
        item = _read_schema_cache().get(_schema_key(connection_name, sql))
    if not item:
        raise OracleUnavailable(f"PM schema cache not found for connection {connection_name}.")
    return item.get("columns") or []


def _invalidate_schema(connection_names):
    names = set(connection_names)
    with _SCHEMA_LOCK:
        payload = _read_schema_cache()
        next_payload = {key: value for key, value in payload.items() if value.get("connection") not in names}
        if next_payload != payload:
            _write_json_atomic(SCHEMA_CACHE_PATH, next_payload)


def save_admin_connections(items):
    if not isinstance(items, list):
        raise ValueError("connections must be an array.")
    existing_items = _read_connections()
    existing = {item["name"]: item for item in existing_items}
    seen_originals = set()
    seen_names = set()
    saved = []
    pool_changed_names = set()
    schema_changed_names = set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Each connection must be an object.")
        original_name = str(item.get("originalName", "")).strip()
        name = str(item.get("name", "")).strip()
        user = str(item.get("user", "")).strip()
        dsn = str(item.get("dsn", "")).strip()
        password = item.get("password") or ""
        if original_name:
            if original_name not in existing or original_name in seen_originals:
                raise ValueError(f"Invalid original connection name: {original_name}")
            seen_originals.add(original_name)
            if not password:
                password = existing[original_name]["password"]
        if not name or name in seen_names:
            raise ValueError(f"Invalid or duplicate connection name: {name}")
        if not user or not password or not dsn:
            raise ValueError(f"Connection requires user, password, and dsn: {name}")
        if not isinstance(item.get("enable"), bool) or not isinstance(item.get("pm"), bool):
            raise ValueError(f"Connection requires boolean enable and pm fields: {name}")
        seen_names.add(name)
        next_item = {"name": name, "user": user, "password": password, "dsn": dsn, "enable": item["enable"], "pm": item["pm"]}
        saved.append(next_item)
        previous = existing.get(original_name) if original_name else None
        if previous and (previous != next_item or original_name != name):
            pool_changed_names.update((original_name, name))
        if previous and (
            original_name != name
            or previous["user"] != user
            or previous["password"] != password
            or previous["dsn"] != dsn
        ):
            schema_changed_names.update((original_name, name))
    deleted_names = set(existing) - seen_originals
    pool_changed_names.update(deleted_names)
    schema_changed_names.update(deleted_names)
    _write_json_atomic(CONNECTIONS_PATH, {"connections": saved})
    _close_pools(pool_changed_names)
    _invalidate_schema(schema_changed_names)
    return list_admin_connections()


def test_connection_settings(name, user, password, dsn, original_name=""):
    if not password and original_name:
        password = load_connection(original_name, require_enabled=False).password
    if not name or not user or not password or not dsn:
        raise ValueError("Connection test requires name, user, password, and dsn.")
    oracledb = _load_oracledb()
    connection = oracledb.connect(user=user, password=password, dsn=dsn)
    try:
        cursor = connection.cursor()
        cursor.execute("select 1 from dual")
        cursor.fetchone()
    finally:
        connection.close()
    return {"success": True, "message": "Connection succeeded."}


def get_connection_pool(connection_name):
    connection = load_connection(connection_name)
    oracledb = _load_oracledb()
    pool_settings = (
        config_int("oracle", "poolMin"),
        config_int("oracle", "poolMax"),
        config_int("oracle", "poolIncrement"),
    )
    connection_key = _pool_key(connection)
    key = (*connection_key, *pool_settings)
    with _POOL_LOCK:
        stale_keys = [
            current_key for current_key in _POOLS
            if current_key[:4] == connection_key and current_key != key
        ]
        stale_pools = [_POOLS.pop(current_key) for current_key in stale_keys]
        for stale_pool in stale_pools:
            try:
                stale_pool.close(force=True)
            except Exception:
                pass
        pool = _POOLS.get(key)
        if pool is None:
            try:
                pool = oracledb.create_pool(
                    user=connection.user,
                    password=connection.password,
                    dsn=connection.dsn,
                    min=pool_settings[0],
                    max=pool_settings[1],
                    increment=pool_settings[2],
                )
            except Exception as exc:
                raise OracleConnectionFailure(f"Oracle connection pool failed: {connection.name}: {exc}") from exc
            _POOLS[key] = pool
    return connection, pool


def acquire_connection(connection_name):
    connection, pool = get_connection_pool(connection_name)
    try:
        return connection, pool.acquire()
    except Exception as exc:
        raise OracleConnectionFailure(f"Oracle connection acquire failed: {connection.name}: {exc}") from exc


def _bind_names_from_sql(sql):
    return set(_BIND_PATTERN.findall(_SQL_COMMENT_OR_STRING_PATTERN.sub("", sql or "")))


def bind_names_from_sql(sql):
    return _bind_names_from_sql(sql)


def _chunks(items, size):
    for index in range(0, len(items), size):
        yield items[index:index + size]


def _oracle_type_name(type_info):
    name = getattr(type_info, "name", None)
    return name if name else str(type_info).replace("<", "").replace(">", "")


def _column_metadata(cursor):
    return [{"name": str(item[0]).lower(), "type": _oracle_type_name(item[1]), "precision": item[4] if len(item) > 4 else None, "scale": item[5] if len(item) > 5 else None, "nullable": item[6] if len(item) > 6 else None} for item in cursor.description or []]


def _empty_dataframe(columns):
    def dtype(column):
        type_name = str(column.get("type", "")).upper()
        if "TIMESTAMP" in type_name or type_name == "DATE":
            return "datetime64[ns]"
        if type_name == "NUMBER" and column.get("scale") == 0:
            return "Int64"
        if type_name in ("NUMBER", "BINARY_FLOAT", "BINARY_DOUBLE", "FLOAT"):
            return "float64"
        return "object"
    frame = pd.DataFrame({column["name"]: pd.Series(dtype=dtype(column)) for column in columns})
    frame.attrs["pm_fallback"] = True
    return frame


def describe_oracle_query(connection_name, sql, params=None):
    sql = _normalize_sql(sql)
    if not sql:
        return []
    config = load_connection(connection_name)
    try:
        _, conn = acquire_connection(connection_name)
    except OracleConnectionFailure:
        if config.pm:
            return _load_schema(connection_name, sql)
        raise
    with conn:
        cursor = conn.cursor()
        cursor.execute(f"select * from ({sql}) where 1 = 0", params or {})
        columns = _column_metadata(cursor)
    _save_schema(connection_name, sql, columns)
    return columns


def execute_oracle_query(connection_name, sql, params=None):
    sql = _normalize_sql(sql)
    if not sql:
        raise OracleUnavailable("DB Read node SQL is empty.")
    config = load_connection(connection_name)
    try:
        _, conn = acquire_connection(connection_name)
    except OracleConnectionFailure:
        if config.pm:
            return _empty_dataframe(_load_schema(connection_name, sql))
        raise
    with conn:
        cursor = conn.cursor()
        cursor.execute(sql, params or {})
        metadata = _column_metadata(cursor)
        rows = cursor.fetchall()
    _save_schema(connection_name, sql, metadata)
    return pd.DataFrame(rows, columns=[column["name"] for column in metadata])


def _rewrite_binds(sql, bind_names, suffix):
    return _BIND_PATTERN.sub(lambda match: f":{match.group(1)}_{suffix}" if match.group(1) in bind_names else match.group(0), sql)


def execute_oracle_query_records(connection_name, sql, bind_records):
    sql = _normalize_sql(sql)
    if not sql:
        raise OracleUnavailable("DB Read node SQL is empty.")
    records = bind_records or [{}]
    bind_names = _bind_names_from_sql(sql)
    if len(records) == 1 or not bind_names:
        return execute_oracle_query(connection_name, sql, {name: records[0].get(name) for name in bind_names})
    batch_sql = "\nunion all\n".join(f"select * from ({_rewrite_binds(sql, bind_names, index)})" for index in range(len(records)))
    bind_params = {f"{name}_{index}": record.get(name) for index, record in enumerate(records) for name in bind_names}
    config = load_connection(connection_name)
    try:
        _, conn = acquire_connection(connection_name)
    except OracleConnectionFailure:
        if config.pm:
            return _empty_dataframe(_load_schema(connection_name, sql))
        raise
    with conn:
        cursor = conn.cursor()
        cursor.execute(batch_sql, bind_params)
        metadata = _column_metadata(cursor)
        rows = cursor.fetchall()
    _save_schema(connection_name, sql, metadata)
    return pd.DataFrame(rows, columns=[column["name"] for column in metadata])


def execute_oracle_write_records(connection_name, sql, bind_records):
    sql = _normalize_sql(sql)
    if not sql:
        raise OracleUnavailable("DB Write node SQL is empty.")
    records = bind_records or []
    if not records:
        return 0
    bind_names = _bind_names_from_sql(sql)
    missing = sorted({name for record in records for name in bind_names if name not in record})
    if missing:
        raise OracleUnavailable(f"DB Write node input is missing bind columns: {', '.join(missing)}")
    records = [{name: record.get(name) for name in bind_names} for record in records]
    config = load_connection(connection_name)
    try:
        _, conn = acquire_connection(connection_name)
    except OracleConnectionFailure:
        if config.pm:
            return None
        raise
    with conn:
        cursor = conn.cursor()
        total = 0
        write_batch_size = max(1, config_int("oracle", "writeBatchSize"))
        for batch in _chunks(records, write_batch_size):
            cursor.execute(sql, batch[0]) if len(batch) == 1 else cursor.executemany(sql, batch)
            if cursor.rowcount and cursor.rowcount > 0:
                total += cursor.rowcount
        conn.commit()
        return total
