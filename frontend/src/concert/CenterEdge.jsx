import { BaseEdge, useStore } from "reactflow";

const fallbackSize = 100;
const sourceGap = 2;
const targetGap = 10;

const nodeCenter = (node, fallbackX, fallbackY) => {
  if (!node) return { x: fallbackX, y: fallbackY, width: fallbackSize, height: fallbackSize };

  const position = node.positionAbsolute || node.position || { x: fallbackX - fallbackSize / 2, y: fallbackY - fallbackSize / 2 };

  return {
    x: position.x + fallbackSize / 2,
    y: position.y + fallbackSize / 2,
    width: fallbackSize,
    height: fallbackSize,
  };
};

const distanceToRectEdge = (width, height, ux, uy) => {
  const xDistance = Math.abs(ux) > 0.0001 ? width / 2 / Math.abs(ux) : Number.POSITIVE_INFINITY;
  const yDistance = Math.abs(uy) > 0.0001 ? height / 2 / Math.abs(uy) : Number.POSITIVE_INFINITY;
  return Math.min(xDistance, yDistance);
};

export default function CenterEdge({
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
}) {
  const sourceNode = useStore((store) => store.nodeInternals.get(source));
  const targetNode = useStore((store) => store.nodeInternals.get(target));

  const sourceCenter = nodeCenter(sourceNode, sourceX, sourceY);
  const targetCenter = nodeCenter(targetNode, targetX, targetY);

  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;

  const startDistance = Math.max(0, distanceToRectEdge(sourceCenter.width, sourceCenter.height, ux, uy) + sourceGap);
  const endDistance = Math.max(0, distanceToRectEdge(targetCenter.width, targetCenter.height, ux, uy) + targetGap);

  const startX = sourceCenter.x + ux * startDistance;
  const startY = sourceCenter.y + uy * startDistance;
  const endX = targetCenter.x - ux * endDistance;
  const endY = targetCenter.y - uy * endDistance;
  const path = `M ${startX} ${startY} L ${endX} ${endY}`;

  return <BaseEdge path={path} markerEnd={markerEnd} style={{ strokeWidth: 2, ...style }} />;
}
