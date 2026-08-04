import json
from pathlib import Path

BRANCH_COUNT = 1000
OUTPUT_PATH = Path(__file__).parent / "dags" / "multi_query.json"


def multiply_code(name):
    return (
        f"def func_{name}(inputs):\n"
        "    df = inputs[0].copy()\n"
        "    df['a'] = df['a'] * 10\n"
        "    return df\n"
    )


def union_code(name):
    return (
        f"def func_{name}(inputs):\n"
        "    return pd.concat(inputs, ignore_index=True)\n"
    )


def edge(source, target):
    return {
        "id": f"edge_{source}_{target}",
        "source": source,
        "target": target,
        "data": {"columns": []},
    }


def make_query(index):
    return {
        "id": f"query_{index:03d}",
        "type": "query",
        "position": {"x": 0, "y": 100 + (index - 1) * 180},
        "data": {
            "name": f"query_{index:03d}",
            "connection": "local",
            "sql": f"select {index} a from dual",
        },
    }


def make_multiply(index, step):
    name = f"multiply_{step}_{index:03d}"
    return {
        "id": name,
        "type": "python",
        "position": {"x": 220 * step, "y": 100 + (index - 1) * 180},
        "data": {
            "name": name,
            "code": multiply_code(name),
        },
    }


def make_union(index):
    name = f"union_{index:03d}"
    return {
        "id": name,
        "type": "python",
        "position": {"x": 720, "y": 100 + (index - 1) * 180},
        "data": {
            "name": name,
            "code": union_code(name),
        },
    }


def main():
    nodes = []
    edges = []

    for index in range(1, BRANCH_COUNT + 1):
        query_id = f"query_{index:03d}"
        first_id = f"multiply_1_{index:03d}"
        second_id = f"multiply_2_{index:03d}"

        nodes.extend(
            [
                make_query(index),
                make_multiply(index, 1),
                make_multiply(index, 2),
            ]
        )
        edges.extend(
            [
                edge(query_id, first_id),
                edge(first_id, second_id),
            ]
        )

    previous_union_source = "multiply_2_001"
    for index in range(2, BRANCH_COUNT + 1):
        union_id = f"union_{index:03d}"
        branch_source = f"multiply_2_{index:03d}"

        nodes.append(make_union(index))
        edges.extend(
            [
                edge(previous_union_source, union_id),
                edge(branch_source, union_id),
            ]
        )
        previous_union_source = union_id

    payload = {
        "version": 1,
        "name": "multi_query",
        "globalVariables": [],
        "inputVariables": [],
        "nodes": nodes,
        "edges": edges,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
