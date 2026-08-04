export default function RunningDialog({ run, onCancel, title, message }) {
  const isCanceling = run?.status === "canceled";

  return (
    <div className="modal-backdrop running-dialog-backdrop">
      <section className="running-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="running-spinner" />
        <h2>{title || (isCanceling ? "Canceling" : "Running")}</h2>
        <p>{message || (isCanceling ? "Cancel request sent." : "Concert is running.")}</p>
        {onCancel && <button onClick={onCancel} disabled={isCanceling}>Cancel</button>}
      </section>
    </div>
  );
}
