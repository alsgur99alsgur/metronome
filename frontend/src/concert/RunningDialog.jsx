export default function RunningDialog({ run, onCancel, onClose, title, message }) {
  const isCanceling = run?.status === "canceled";
  const isError = run?.status === "error";

  return (
    <div className="modal-backdrop running-dialog-backdrop">
      <section className={`running-dialog ${isError ? "error" : ""}`} onClick={(event) => event.stopPropagation()}>
        {!isError && <div className="running-spinner" />}
        <h2>{title || (isError ? "Run failed" : isCanceling ? "Canceling" : "Running")}</h2>
        <p>{message || (isError ? run.error || "The backend reported an error." : isCanceling ? "Cancel request sent." : "Concert is running.")}</p>
        {isError && onClose && <button onClick={onClose}>Close</button>}
        {!isError && onCancel && <button onClick={onCancel} disabled={isCanceling}>Cancel</button>}
      </section>
    </div>
  );
}
