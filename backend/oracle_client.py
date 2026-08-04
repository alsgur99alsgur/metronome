import json
import os
import re
from dataclasses import dataclass
from threading import Lock

import pandas as pd

from app_config import config_int


CONNECTIONS_PATH = "./connections.json"
ORACLE_POOL_MIN = config_int("oracle", "poolMin")
ORACLE_POOL_MAX = config_int("oracle", "poolMax")
ORACLE_POOL_INCREMENT = config_int("oracle", "poolIncrement")
ORACLE_WRITE_BATCH_SIZE = config_int("oracle", "writeBatchSize")
_BIND_PATTERN = re.compile(r"(?<!:):([A-Za-z_][A-Za-z0-9_]*)")
_SQL_COMMENT_OR_STRING_PATTERN = re.compile(
    r"(--[^\n]*|/\*.*?\*/|'(?:''|[^'])*')",
    re.DOTALL,
)
_POOL_LOCK = Lock()
_POOLS = {}


@dataclass
class OracleConnection:
    name: str
    user: str
    password: str
    dsn: str


class OracleUnavailable(Exception):
    pass


def _load_oracledb():
    try:
        import oracledb  # type: ignore
    except ModuleNotFoundError as exc:
        raise OracleUnavailable("python-oracledb is not installed.") from exc
    return oracledb


def _normalize_sql(sql):
    return (sql or "").strip().rstrip(";")


def _bind_names_from_sql(sql):
    return set(_BIND_PATTERN.findall(_SQL_COMMENT_OR_STRING_PATTERN.sub("", sql or "")))


def _chunks(items, size):
    for index in range(0, len(items), size):
        yield items[index:index + size]


def get_connection_pool(connection_name):
    oracledb = _load_oracledb()
    connection = load_connection(connection_name)
    pool_key = (connection.name, connection.user, connection.dsn)

    with _POOL_LOCK:
        pool = _POOLS.get(pool_key)
        if pool is None:
            pool = oracledb.create_pool(
                user=connection.user,
                password=connection.password,
                dsn=connection.dsn,
                min=ORACLE_POOL_MIN,
                max=ORACLE_POOL_MAX,
                increment=ORACLE_POOL_INCREMENT,
            )
            _POOLS[pool_key] = pool
        return pool


def acquire_connection(connection_name):
    return get_connection_pool(connection_name).acquire()


def load_connection(connection_name, path=CONNECTIONS_PATH):
    if not connection_name:
        raise OracleUnavailable("DB Read node has no Oracle connection selected.")
    if not os.path.exists(path):
        raise OracleUnavailable(f"Connection registry not found: {path}")

    with open(path, "r", encoding="utf-8") as file:
        payload = json.load(file)

    connections = payload["connections"]
    for item in connections:
        if item.get("name") == connection_name:
            return OracleConnection(
                name=item["name"],
                user=item["user"],
                password=item["password"],
                dsn=item["dsn"],
            )

    raise OracleUnavailable(f"Oracle connection not found: {connection_name}")


def list_connection_names(path=CONNECTIONS_PATH):
    if not os.path.exists(path):
        return []

    with open(path, "r", encoding="utf-8") as file:
        payload = json.load(file)

    connections = payload["connections"]
    return sorted(item["name"] for item in connections if item.get("name"))


def _oracle_type_name(type_info):
    name = getattr(type_info, "name", None)
    if name:
        return name
    return str(type_info).replace("<", "").replace(">", "")


def _column_metadata(cursor):
    columns = []
    for item in cursor.description or []:
        name = item[0]
        type_name = _oracle_type_name(item[1])
        precision = item[4] if len(item) > 4 else None
        scale = item[5] if len(item) > 5 else None
        nullable = item[6] if len(item) > 6 else None
        columns.append(
            {
                "name": str(name).lower(),
                "type": type_name,
                "precision": precision,
                "scale": scale,
                "nullable": nullable,
            }
        )
    return columns


def describe_oracle_query(connection_name, sql, params=None):
    sql = _normalize_sql(sql)
    if not sql:
        return []

    bind_params = params or {}
    describe_sql = f"select * from ({sql}) where 1 = 0"

    with acquire_connection(connection_name) as conn:
        cursor = conn.cursor()
        cursor.execute(describe_sql, bind_params)
        return _column_metadata(cursor)


def execute_oracle_query(connection_name, sql, params=None):
    sql = _normalize_sql(sql)
    if not sql:
        raise OracleUnavailable("DB Read node SQL is empty.")

    bind_params = params or {}

    with acquire_connection(connection_name) as conn:
        cursor = conn.cursor()
        cursor.execute(sql, bind_params)
        columns = [column[0].lower() for column in cursor.description or []]
        rows = cursor.fetchall()

    return pd.DataFrame(rows, columns=columns)


def _rewrite_binds(sql, bind_names, suffix):
    def replace(match):
        name = match.group(1)
        if name not in bind_names:
            return match.group(0)
        return f":{name}_{suffix}"

    return _BIND_PATTERN.sub(replace, sql)


def execute_oracle_query_records(connection_name, sql, bind_records):
    sql = _normalize_sql(sql)
    if not sql:
        raise OracleUnavailable("DB Read node SQL is empty.")

    records = bind_records or [{}]
    sql_bind_names = _bind_names_from_sql(sql)

    if len(records) == 1 or not sql_bind_names:
        bind_params = {name: records[0].get(name) for name in sql_bind_names}
        return execute_oracle_query(connection_name, sql, params=bind_params)

    query_parts = []
    bind_params = {}
    for index, record in enumerate(records):
        query_parts.append(f"select * from ({_rewrite_binds(sql, sql_bind_names, index)})")
        for name in sql_bind_names:
            bind_params[f"{name}_{index}"] = record.get(name)

    batch_sql = "\nunion all\n".join(query_parts)
    with acquire_connection(connection_name) as conn:
        cursor = conn.cursor()
        cursor.execute(batch_sql, bind_params)
        columns = [column[0].lower() for column in cursor.description or []]
        rows = cursor.fetchall()

    return pd.DataFrame(rows, columns=columns)


def execute_oracle_write_records(connection_name, sql, bind_records):
    sql = _normalize_sql(sql)
    if not sql:
        raise OracleUnavailable("DB Write node SQL is empty.")

    records = bind_records or []
    if not records:
        return 0

    sql_bind_names = _bind_names_from_sql(sql)
    missing_names = sorted(
        {
            name
            for record in records
            for name in sql_bind_names
            if name not in record
        }
    )
    if missing_names:
        raise OracleUnavailable(
            f"DB Write node input is missing bind columns: {', '.join(missing_names)}"
        )

    bind_records = [
        {name: record.get(name) for name in sql_bind_names}
        for record in records
    ]

    with acquire_connection(connection_name) as conn:
        cursor = conn.cursor()
        total_row_count = 0
        batch_size = max(1, ORACLE_WRITE_BATCH_SIZE)
        for batch in _chunks(bind_records, batch_size):
            if len(batch) == 1:
                cursor.execute(sql, batch[0])
            else:
                cursor.executemany(sql, batch)
            if cursor.rowcount and cursor.rowcount > 0:
                total_row_count += cursor.rowcount
        conn.commit()
        return total_row_count
