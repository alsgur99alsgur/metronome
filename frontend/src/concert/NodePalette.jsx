import { nodeIcon, nodeStyle } from "./Node";

const groups = [
  [{ type: "dbRead", label: "DB Read" }, { type: "cacheRead", label: "Cache Read" }],
  [{ type: "python", label: "Python" }],
  [{ type: "dbWrite", label: "DB Write" }, { type: "cacheWrite", label: "Cache Write" }],
  [{ type: "concert", label: "Con Call" }, { type: "concertInput", label: "Input" }, { type: "concertOutput", label: "Output" }],
  [{ type: "loopIn", label: "Loop In" }, { type: "loopOut", label: "Loop Out" }],
  [{ type: "opl", label: "OPL" }],
  [{ type: "text", label: "Text" }],
];

export default function NodePalette({ disabledTypes = new Set() }) {
  return <aside className="node-palette" aria-label="Node palette">
    {groups.map((group) => <div className="palette-group" key={group.map(({ type }) => type).join("-")}>
      {group.map(({ type, label }) => {
        const Icon = nodeIcon[type] || nodeIcon.python;
        const disabled = disabledTypes.has(type);
        return <button key={type} className={`palette-item ${disabled ? "disabled" : ""}`} disabled={disabled} draggable={!disabled} onDragStart={(event) => {
          event.dataTransfer.setData("application/metronome-node", type);
          event.dataTransfer.effectAllowed = "copy";
        }} title={label}>
          <span className={`palette-node${type === "text" ? " text-palette-node" : ""}`} style={nodeStyle[type]}><Icon fontSize="small" /></span>
          <span className="palette-label">{label}</span>
        </button>;
      })}
    </div>)}
  </aside>;
}
