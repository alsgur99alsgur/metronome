import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";

export default function OutputColumnsTitle({ onRefresh, refreshing = false }) {
  return (
    <div className="column-title column-title-with-action">
      <span>Output Columns</span>
      {onRefresh && (
        <button
          type="button"
          className={`column-refresh-button${refreshing ? " refreshing" : ""}`}
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh downstream output columns"
          aria-label="Refresh downstream output columns"
        >
          <RefreshRoundedIcon fontSize="inherit" />
        </button>
      )}
    </div>
  );
}
