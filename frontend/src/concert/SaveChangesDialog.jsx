export default function SaveChangesDialog({ onSave, onDiscard, onCancel }) {
  return (
    <div className="modal-backdrop save-dialog-backdrop" role="presentation">
      <div
        className="save-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-dialog-title"
      >
        <h3 id="save-dialog-title">저장하겠습니까?</h3>
        <p>변경사항이 저장되지 않았습니다.</p>
        <div className="save-dialog-actions">
          <button className="primary-button" onClick={onSave}>
            예
          </button>
          <button onClick={onDiscard}>아니오</button>
          <button onClick={onCancel}>취소</button>
        </div>
      </div>
    </div>
  );
}
