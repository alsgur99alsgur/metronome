import { Handle, Position } from "reactflow";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import DataObjectOutlinedIcon from "@mui/icons-material/DataObjectOutlined";
import CalculateOutlinedIcon from "@mui/icons-material/CalculateOutlined";
import LoginOutlinedIcon from "@mui/icons-material/LoginOutlined";
import LogoutOutlinedIcon from "@mui/icons-material/LogoutOutlined";
import MemoryOutlinedIcon from "@mui/icons-material/MemoryOutlined";
import RepeatOutlinedIcon from "@mui/icons-material/RepeatOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import NotesOutlinedIcon from "@mui/icons-material/NotesOutlined";
import SvgIcon from "@mui/material/SvgIcon";

function PythonIcon(props) {
  return (
    <SvgIcon {...props} viewBox="0 0 24 24">
      <path
        fill="#3776ab"
        d="M11.8 2C8.7 2 7.2 2.8 7.2 4.5V7h5.5v1.2H5.4C3.5 8.2 2 9.8 2 12c0 2.1 1.5 3.8 3.4 3.8h1.9v-2.5c0-2 1.6-3.4 3.6-3.4h4.8c1.6 0 3-1.4 3-3V4.5C18.7 2.8 17.2 2 14.1 2h-2.3Z"
      />
      <path
        fill="#ffd43b"
        d="M12.2 22c3.1 0 4.6-.8 4.6-2.5V17h-5.5v-1.2h7.3c1.9 0 3.4-1.6 3.4-3.8 0-2.1-1.5-3.8-3.4-3.8h-1.9v2.5c0 2-1.6 3.4-3.6 3.4H8.3c-1.6 0-3 1.4-3 3v2.4C5.3 21.2 6.8 22 9.9 22h2.3Z"
      />
      <circle cx="9.1" cy="4.8" r="0.8" fill="#ffffff" />
      <circle cx="14.9" cy="19.2" r="0.8" fill="#ffffff" />
    </SvgIcon>
  );
}

export const nodeStyle = {
  dbRead: {
    borderColor: "#2563eb",
    background: "#eff6ff",
  },
  python: {
    borderColor: "#16a34a",
    background: "#f0fdf4",
  },
  opl: {
    borderColor: "#0f766e",
    background: "#f0fdfa",
  },
  dbWrite: {
    borderColor: "#f97316",
    background: "#fff7ed",
  },
  concert: {
    borderColor: "#7c3aed",
    background: "#f5f3ff",
  },
  concertInput: {
    borderColor: "#7c3aed",
    background: "#f5f3ff",
  },
  concertOutput: {
    borderColor: "#7c3aed",
    background: "#f5f3ff",
  },
  loopIn: {
    borderColor: "#0891b2",
    background: "#ecfeff",
  },
  loopOut: {
    borderColor: "#0891b2",
    background: "#ecfeff",
  },
  cacheRead: { borderColor: "#2563eb", background: "#eff6ff" },
  cacheWrite: { borderColor: "#f97316", background: "#fff7ed" },
  text: { borderColor: "#64748b", background: "#fffde7" },
};

export const statusLabel = {
  skipped: "skipped",
  pending: "pending",
  running: "running",
  success: "success",
  error: "error",
};

export const nodeIcon = {
  dbRead: StorageOutlinedIcon,
  python: PythonIcon,
  opl: CalculateOutlinedIcon,
  dbWrite: StorageOutlinedIcon,
  concert: AccountTreeOutlinedIcon,
  concertInput: LoginOutlinedIcon,
  concertOutput: LogoutOutlinedIcon,
  cacheRead: MemoryOutlinedIcon,
  cacheWrite: MemoryOutlinedIcon,
  loopIn: RepeatOutlinedIcon,
  loopOut: RepeatOutlinedIcon,
  text: NotesOutlinedIcon,
};

export default function Node({ data, type, selected }) {
  const status = data.status || "skipped";
  const isConnectMode = Boolean(data.isConnectMode);
  const hasRunMeta = data.runRows != null || data.runDurationMs != null;
  const showLoopIterations =
    (type === "loopIn" || type === "loopOut") &&
    data.runLoopIterations != null;
  const Icon = nodeIcon[type] || DataObjectOutlinedIcon;
  const durationText =
    data.runDurationMs == null
      ? "-"
      : data.runDurationMs >= 1000
        ? `${(data.runDurationMs / 1000).toFixed(1)}s`
        : `${data.runDurationMs}ms`;

  return (
    <div className="concert-node-shell">
      <div
        className={`concert-node ${selected ? "selected" : ""} ${status} ${isConnectMode ? "connect-mode" : ""}`}
        style={nodeStyle[type]}
      >
        <Handle
          className="easy-connect-handle target-handle"
          type="target"
          position={Position.Left}
          isConnectable={isConnectMode}
        />
        <Handle
          className="easy-connect-handle source-handle"
          type="source"
          position={Position.Right}
          isConnectable={isConnectMode}
        />

        <div className="node-icon" title={({ dbRead: "DB Read", dbWrite: "DB Write" })[type] || type} aria-label={({ dbRead: "DB Read", dbWrite: "DB Write" })[type] || type}>
          <Icon fontSize="small" />
        </div>
        <div className={`node-status ${status}`}>
          {statusLabel[status] || status}
        </div>
      </div>
      <div className="node-name">{data.name}</div>
      {hasRunMeta && (
        <div className="node-run-meta">
          <span>rows: {data.runRows != null ? data.runRows : "-"}</span>
          <span>time: {durationText}</span>
        </div>
      )}
      {showLoopIterations && (
        <div className="node-run-meta node-loop-meta">
          <span>loops: {data.runLoopIterations}</span>
        </div>
      )}
    </div>
  );
}
