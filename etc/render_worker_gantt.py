import argparse
import html
import json
import os
import re
import sys


BACKEND_ROOT = os.path.dirname(os.path.abspath(__file__))
DEFAULT_REPLAY_ROOT = os.path.join(BACKEND_ROOT, "replay")


def _safe_name(name):
    return re.sub(r"[^a-zA-Z0-9_.-]+", "_", str(name or "")).strip("_") or "untitled"


def _load_metadata(path):
    metadata_path = os.path.join(path, "metadata.json")
    if not os.path.exists(metadata_path):
        return {}
    with open(metadata_path, "r", encoding="utf-8") as file:
        return json.load(file)


def _cache_paths(replay_root):
    if not os.path.isdir(replay_root):
        return []
    paths = []
    for dag_name in sorted(os.listdir(replay_root)):
        dag_path = os.path.join(replay_root, dag_name)
        if not os.path.isdir(dag_path):
            continue
        for replay_id in sorted(os.listdir(dag_path)):
            cache_path = os.path.join(dag_path, replay_id, "cache")
            if not os.path.isdir(cache_path):
                continue
            if "metadata.json" not in os.listdir(cache_path):
                continue
            metadata = _load_metadata(cache_path)
            cache_id = metadata.get("id") or _safe_name(replay_id)
            paths.append((dag_name, cache_id, cache_path, replay_id, metadata))
    return paths


def _find_cache(replay_root, cache_id=None, dag_name=None):
    if cache_id:
        safe_cache_id = _safe_name(cache_id)
        for current in _cache_paths(replay_root):
            _, current_cache_id, _, _, metadata = current
            if current_cache_id == safe_cache_id or metadata.get("sourceReplayId") == safe_cache_id:
                return current
        raise FileNotFoundError(f"Cache not found: {cache_id}")

    caches = _cache_paths(replay_root)
    if dag_name:
        safe_dag_name = _safe_name(dag_name)
        caches = [item for item in caches if item[0] == safe_dag_name]
    if not caches:
        raise FileNotFoundError("No cache runs found.")

    return max(caches, key=lambda item: item[4].get("createdAt") or "")


def _timeline_nodes(metadata):
    nodes = []
    for node in (metadata.get("nodes") or {}).values():
        worker_id = node.get("workerId")
        started_at_ms = node.get("startedAtMs")
        finished_at_ms = node.get("finishedAtMs")
        if worker_id is None or started_at_ms is None or finished_at_ms is None:
            continue
        try:
            started_at_ms = int(started_at_ms)
            finished_at_ms = int(finished_at_ms)
        except (TypeError, ValueError):
            continue
        if finished_at_ms < started_at_ms:
            continue
        nodes.append(
            {
                "id": node.get("id", ""),
                "name": node.get("name") or node.get("id") or "",
                "type": node.get("type", "unknown"),
                "status": node.get("status", "unknown"),
                "workerId": int(worker_id),
                "startMs": started_at_ms,
                "endMs": finished_at_ms,
                "durationMs": int(node.get("durationMs") or finished_at_ms - started_at_ms),
                "rows": node.get("rows"),
                "error": node.get("error"),
            }
        )
    return nodes


def _render_html(dag_name, cache_id, metadata, nodes):
    min_start = min(item["startMs"] for item in nodes)
    max_end = max(item["endMs"] for item in nodes)
    for item in nodes:
        item["offsetMs"] = item["startMs"] - min_start
        item["spanMs"] = max(1, item["endMs"] - item["startMs"])

    workers = sorted({item["workerId"] for item in nodes})
    total_ms = max(1, max_end - min_start)
    data = {
        "dagName": dag_name,
        "cacheId": cache_id,
        "createdAt": metadata.get("createdAt", ""),
        "status": metadata.get("status", ""),
        "totalMs": total_ms,
        "workers": workers,
        "nodes": nodes,
    }
    payload = json.dumps(data, ensure_ascii=False, allow_nan=True)
    title = html.escape(f"{dag_name} worker gantt")
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <style>
    :root {{
      color-scheme: light;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f8fafc;
      color: #111827;
    }}
    body {{
      margin: 0;
      padding: 24px;
    }}
    .wrap {{
      max-width: 1440px;
      margin: 0 auto;
    }}
    h1 {{
      margin: 0 0 6px;
      font-size: 22px;
    }}
    .meta {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 18px;
      color: #475569;
      font-size: 13px;
      font-weight: 700;
    }}
    .pill {{
      border: 1px solid #d7dce2;
      border-radius: 999px;
      background: #ffffff;
      padding: 6px 10px;
    }}
    .panel {{
      border: 1px solid #d7dce2;
      border-radius: 8px;
      background: #ffffff;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.08);
      overflow-x: auto;
    }}
    svg {{
      display: block;
      min-width: 980px;
    }}
    .axis text, .lane-label, .bar-label {{
      font-size: 12px;
      fill: #334155;
      font-weight: 700;
    }}
    .grid {{
      stroke: #e2e8f0;
      stroke-width: 1;
    }}
    .lane-bg:nth-child(odd) {{
      fill: #f8fafc;
    }}
    .lane-bg:nth-child(even) {{
      fill: #ffffff;
    }}
    .bar {{
      rx: 4;
      ry: 4;
      stroke-width: 1;
    }}
    .query {{ fill: #bfdbfe; stroke: #60a5fa; }}
    .python {{ fill: #bbf7d0; stroke: #4ade80; }}
    .write {{ fill: #fed7aa; stroke: #fb923c; }}
    .dag {{ fill: #ddd6fe; stroke: #a78bfa; }}
    .other {{ fill: #e2e8f0; stroke: #94a3b8; }}
    .error {{ fill: #fecaca; stroke: #ef4444; }}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Worker Gantt</h1>
    <div class="meta" id="meta"></div>
    <div class="panel">
      <svg id="chart" role="img" aria-label="Worker task timeline"></svg>
    </div>
  </div>
  <script>
    const data = {payload};
    const meta = document.getElementById("meta");
    const chart = document.getElementById("chart");
    const fmt = (ms) => {{
      if (ms < 1000) return `${{Math.round(ms)}} ms`;
      const seconds = ms / 1000;
      if (seconds < 60) return `${{seconds.toFixed(seconds >= 10 ? 1 : 2)}} s`;
      const minutes = Math.floor(seconds / 60);
      return `${{minutes}}m ${{(seconds - minutes * 60).toFixed(1)}}s`;
    }};
    meta.innerHTML = [
      ["DAG", data.dagName],
      ["Cache", data.cacheId],
      ["Status", data.status || "unknown"],
      ["Workers used", data.workers.length],
      ["Tasks", data.nodes.length],
      ["Elapsed", fmt(data.totalMs)]
    ].map(([label, value]) => `<span class="pill">${{label}}: ${{value}}</span>`).join("");

    const margin = {{ left: 112, right: 28, top: 42, bottom: 26 }};
    const rowH = 38;
    const width = 1400;
    const plotW = width - margin.left - margin.right;
    const height = margin.top + margin.bottom + data.workers.length * rowH;
    chart.setAttribute("viewBox", `0 0 ${{width}} ${{height}}`);
    chart.setAttribute("width", width);
    chart.setAttribute("height", height);
    const x = (ms) => margin.left + (ms / data.totalMs) * plotW;
    const workerIndex = new Map(data.workers.map((id, index) => [id, index]));
    const ns = "http://www.w3.org/2000/svg";
    const make = (tag, attrs = {{}}, text = "") => {{
      const el = document.createElementNS(ns, tag);
      Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
      if (text) el.textContent = text;
      return el;
    }};

    const tickCount = Math.min(10, Math.max(2, Math.ceil(data.totalMs / 1000)));
    for (let i = 0; i <= tickCount; i += 1) {{
      const ms = (data.totalMs / tickCount) * i;
      const tx = x(ms);
      chart.appendChild(make("line", {{ x1: tx, y1: margin.top - 10, x2: tx, y2: height - margin.bottom, class: "grid" }}));
      chart.appendChild(make("text", {{ x: tx, y: 24, "text-anchor": i === 0 ? "start" : i === tickCount ? "end" : "middle", class: "axis" }}, fmt(ms)));
    }}

    data.workers.forEach((workerId, index) => {{
      const y = margin.top + index * rowH;
      chart.appendChild(make("rect", {{ x: 0, y, width, height: rowH, class: "lane-bg" }}));
      chart.appendChild(make("text", {{ x: 16, y: y + 24, class: "lane-label" }}, `worker ${{workerId}}`));
    }});

    data.nodes.forEach((node) => {{
      const lane = workerIndex.get(node.workerId);
      const y = margin.top + lane * rowH + 7;
      const bx = x(node.offsetMs);
      const bw = Math.max(2, (node.spanMs / data.totalMs) * plotW);
      const cls = node.status === "error" ? "error" : ["query", "python", "write", "dag"].includes(node.type) ? node.type : "other";
      const rect = make("rect", {{ x: bx, y, width: bw, height: 24, class: `bar ${{cls}}` }});
      const title = make("title", {{}}, `${{node.name}}\\n${{node.type}} / ${{node.status}}\\nworker ${{node.workerId}}\\nstart +${{fmt(node.offsetMs)}}\\nduration ${{fmt(node.spanMs)}}${{node.rows == null ? "" : "\\nrows " + node.rows}}${{node.error ? "\\n" + node.error : ""}}`);
      rect.appendChild(title);
      chart.appendChild(rect);
      if (bw > 86) {{
        const label = node.name.length > 24 ? `${{node.name.slice(0, 22)}}...` : node.name;
        chart.appendChild(make("text", {{ x: bx + 6, y: y + 17, class: "bar-label" }}, label));
      }}
    }});
  </script>
</body>
</html>
"""


def main():
    parser = argparse.ArgumentParser(description="Render a worker Gantt chart from run cache metadata.")
    parser.add_argument("--cache-id", help="Cache id or replay id. Defaults to the latest cache.")
    parser.add_argument("--dag-name", help="Only search latest cache for this DAG name.")
    parser.add_argument("--replay-root", default=DEFAULT_REPLAY_ROOT)
    parser.add_argument("--output", help="Output HTML path. Defaults to <cache>/worker_gantt.html.")
    args = parser.parse_args()

    replay_root = os.path.abspath(args.replay_root)
    dag_name, cache_id, cache_path, _, metadata = _find_cache(
        replay_root,
        cache_id=args.cache_id,
        dag_name=args.dag_name,
    )
    nodes = _timeline_nodes(metadata)
    if not nodes:
        raise SystemExit(
            "No worker timeline data found. Run a DAG once after this instrumentation change, then rerun this script."
        )

    output_path = args.output or os.path.join(cache_path, "worker_gantt.html")
    output_path = os.path.abspath(output_path)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as file:
        file.write(_render_html(dag_name, cache_id, metadata, nodes))
    print(output_path)


if __name__ == "__main__":
    sys.exit(main())
