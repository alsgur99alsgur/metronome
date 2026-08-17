import { useEffect, useState } from "react";

export default function RunningDialog({ run, onCancel, onClose, title, message }) {
  const isCanceling = run?.status === "canceled";
  const isError = run?.status === "error";
  const runKey = run?.runId || run?.id || "";
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [runKey]);

  return (
    <div className="modal-backdrop running-dialog-backdrop">
      <section className={`running-dialog ${isError ? "error" : ""}`} onClick={(event) => event.stopPropagation()}>
        {!isError && <div className="running-spinner" />}
        <h2>{title || (isError ? "Run failed" : isCanceling ? "Canceling" : "Running")}</h2>
        {(message || isError || isCanceling) && (
          <p>{message || (isError ? run.error || "The backend reported an error." : "Cancel request sent.")}</p>
        )}
        {!title && !isError && run?.execution && (
          <div className="running-limits">
            <span>Elapsed <strong>{elapsedSeconds}s</strong></span>
          </div>
        )}
        {isError && onClose && <button onClick={onClose}>Close</button>}
        {!isError && onCancel && <button onClick={onCancel} disabled={isCanceling}>Cancel</button>}
      </section>
    </div>
  );
}
