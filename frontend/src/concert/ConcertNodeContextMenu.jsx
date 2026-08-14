export default function ConcertNodeContextMenu({ menu, menuRef, onViewData, onViewLp, onViewIterations, onOpenConcert, onBringToFront, onSendToBack, canViewLp, canViewIterations }) {
  if (!menu) return null;
  const { node } = menu;
  const isText = node.type === "text";

  return (
    <div ref={menuRef} className="context-menu" style={{ left: menu.x, top: menu.y }}>
      {isText && <>
        <button onClick={() => onBringToFront(node)}>Bring to Front</button>
        <button onClick={() => onSendToBack(node)}>Send to Back</button>
      </>}
      {!isText && <button onClick={() => onViewData(node)}>View Data</button>}
      {!isText && canViewIterations && <button onClick={() => onViewIterations(node)}>View Iterations</button>}
      {node.type === "opl" && canViewLp && <button onClick={() => onViewLp(node)}>View LP</button>}
      {node.type === "concert" && node.data?.concertName && <button onClick={() => onOpenConcert(node)}>Open Concert</button>}
    </div>
  );
}
