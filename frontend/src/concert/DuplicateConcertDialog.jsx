import { useEffect } from "react";

export default function DuplicateConcertDialog({ concertName, busy, onSaveAs, onCancel }) {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [busy, onCancel]);

  return (
    <div className="modal-backdrop save-dialog-backdrop" role="presentation">
      <div className="save-dialog" role="dialog" aria-modal="true" aria-labelledby="duplicate-concert-title">
        <h3 id="duplicate-concert-title">Concert already open</h3>
        <p>
          A server Concert named &quot;{concertName}&quot; is already open.
          Would you like to save this Concert locally and open it?
        </p>
        <div className="save-dialog-actions">
          <button type="button" className="primary-button" disabled={busy} onClick={onSaveAs}>Yes</button>
          <button type="button" disabled={busy} onClick={onCancel}>No</button>
        </div>
      </div>
    </div>
  );
}
