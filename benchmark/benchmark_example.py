import json
import os


def _query_sql(query_index):
    numeric_columns = [f"level * {index + 1} as n{index + 1:02d}" for index in range(9)]
    text_columns = [
        f"'q{query_index:02d}_' || to_char(level) || '_{index + 1}' as s{index + 1:02d}"
        for index in range(9)
    ]
    columns = [
        f"{query_index} as query_id",
        "level as row_id",
        *numeric_columns,
        *text_columns,
    ]
    return "select\n  " + ",\n  ".join(columns) + "\nfrom dual\nconnect by level <= 100"


def build_benchmark_concert(connection_name="local"):
    nodes = []
    edges = []
    for index in range(1, 31):
        node_id = f"benchmark_db_{index:02d}"
        nodes.append(
            {
                "id": node_id,
                "type": "dbRead",
                "position": {
                    "x": 40 + ((index - 1) % 6) * 220,
                    "y": 40 + ((index - 1) // 6) * 130,
                },
                "data": {
                    "name": f"query_{index:02d}",
                    "connection": connection_name,
                    "sql": _query_sql(index),
                },
            }
        )
        edges.append(
            {
                "id": f"edge_{node_id}_union",
                "source": node_id,
                "target": "benchmark_union",
                "data": {},
            }
        )

    nodes.append(
        {
            "id": "benchmark_union",
            "type": "python",
            "position": {"x": 1450, "y": 280},
            "data": {
                "name": "union_30_queries",
                "code": "def func_union_30_queries(inputs):\n    return pd.concat(inputs, ignore_index=True, copy=False)",
            },
        }
    )
    nodes.append(
        {
            "id": "benchmark_loop_in",
            "type": "loopIn",
            "position": {"x": 1700, "y": 280},
            "data": {
                "name": "each_row_loop",
                "iterationMode": "eachRow",
                "groupByColumns": "",
            },
        }
    )
    edges.append(
        {
            "id": "edge_union_loop",
            "source": "benchmark_union",
            "target": "benchmark_loop_in",
            "data": {},
        }
    )

    previous = "benchmark_loop_in"
    for index in range(1, 11):
        node_id = f"benchmark_python_{index:02d}"
        name = f"loop_python_{index:02d}"
        nodes.append(
            {
                "id": node_id,
                "type": "python",
                "position": {"x": 1950 + (index - 1) * 210, "y": 280},
                "data": {
                    "name": name,
                    "code": (
                        f"def func_{name}(inputs):\n"
                        "    df = inputs[0]\n"
                        f"    df['calc_{index:02d}'] = df['row_id'] * {index} + df['query_id']\n"
                        "    return df"
                    ),
                },
            }
        )
        edges.append(
            {
                "id": f"edge_{previous}_{node_id}",
                "source": previous,
                "target": node_id,
                "data": {},
            }
        )
        previous = node_id

    nodes.append(
        {
            "id": "benchmark_loop_out",
            "type": "loopOut",
            "position": {"x": 4100, "y": 280},
            "data": {
                "name": "benchmark_loop_out",
                "maxIterations": "0",
                "stopConditions": [],
            },
        }
    )
    edges.append(
        {
            "id": f"edge_{previous}_loop_out",
            "source": previous,
            "target": "benchmark_loop_out",
            "data": {},
        }
    )
    return {
        "concertId": "backend-performance-benchmark",
        "name": "backend_performance_benchmark",
        "nodes": nodes,
        "edges": edges,
        "globalVariables": [],
        "inputVariables": [],
    }


def write_benchmark_concert(path, connection_name="local"):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        json.dump(
            build_benchmark_concert(connection_name), file, ensure_ascii=False, indent=2
        )
        file.write("\n")
