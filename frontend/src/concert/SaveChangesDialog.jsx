import { useEffect } from "react";

export default function SaveChangesDialog({ onSave, onDiscard, onCancel }) {
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onCancel]);

  return (
    <div className="modal-backdrop save-dialog-backdrop" role="presentation">
      <div
        className="save-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-dialog-title"
      >
        <h3 id="save-dialog-title">Save changes?</h3>
        <p>Your changes have not been saved.</p>
        <div className="save-dialog-actions">
          <button type="button" className="primary-button" onClick={onSave}>
            Yes
          </button>
          <button type="button" onClick={onDiscard}>No</button>
          <button type="button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
