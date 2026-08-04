import json
from pathlib import Path

NODE_COUNT = 1000
OUTPUT_PATH = Path(__file__).parent / "dags" / "big_linear_1000.json"


def make_node(index):
    node_id = f"node_{index:04d}"
    node_type = "python"
    data = {"name": f"{node_type}_{index + 1}"}

    if node_type == "dagInput":
        data["inputIndex"] = 0
    else:
        data["code"] = (
            f"def func_python_{index + 1}(inputs):\n"
            "    if inputs:\n"
            "        df = inputs[0]\n"
            "    else:\n"
            "        df = pd.DataFrame()\n"
            f"    df['test'] = {index + 1}\n"
            "    return df\n"
        )

    return {
        "id": node_id,
        "type": node_type,
        "position": {"x": 400, "y": 100 + index * 200},
        "data": data,
    }


def make_edge(index):
    source = f"node_{index:04d}"
    target = f"node_{index + 1:04d}"
    return {
        "id": f"edge_{index:04d}_{index + 1:04d}",
        "source": source,
        "target": target,
        "data": {"columns": []},
    }


def main():
    nodes = [make_node(index) for index in range(NODE_COUNT)]
    edges = [make_edge(index) for index in range(NODE_COUNT - 1)]
    payload = {
        "name": "big_linear_1000",
        "nodes": nodes,
        "edges": edges,
        "globalVariables": [],
        "inputVariables": [],
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
