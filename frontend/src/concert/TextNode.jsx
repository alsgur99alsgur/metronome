import { useContext } from "react";
import { NodeResizer } from "reactflow";
import TextNodeResizeContext from "./TextNodeResizeContext";

export default function TextNode({ id, data, selected }) {
  const onResizeEnd = useContext(TextNodeResizeContext);

  return (
    <div
      className={`text-node${selected ? " selected" : ""}`}
      style={{
        backgroundColor: data.backgroundColor || "#fffde7",
        color: data.textColor || "#1f2937",
        fontSize: `${data.fontSize || 16}px`,
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={100}
        minHeight={100}
        lineClassName="text-node-resizer-line"
        handleClassName="text-node-resizer-handle"
        onResizeEnd={(_, size) => onResizeEnd?.(id, size)}
      />
      <div className="text-node-content">{data.text || ""}</div>
    </div>
  );
}
