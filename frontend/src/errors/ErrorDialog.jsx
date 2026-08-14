import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import "./ErrorDialog.css";

const ErrorDialogContext = createContext(null);
let externalReporter = null;

const errorMessage = (value) => {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  return value == null ? "An unexpected error occurred." : String(value);
};

export const reportError = (value, title = "Error") => {
  externalReporter?.(value, title);
};

export function ErrorDialogProvider({ children }) {
  const [error, setError] = useState(null);
  const showError = useCallback((value, title = "Error") => {
    setError({ title, message: errorMessage(value) });
  }, []);
  const closeError = useCallback(() => setError(null), []);

  useEffect(() => {
    externalReporter = showError;
    const handleError = (event) => {
      event.preventDefault();
      showError(event.error || event.message);
    };
    const handleRejection = (event) => {
      event.preventDefault();
      showError(event.reason);
    };
    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    return () => {
      if (externalReporter === showError) externalReporter = null;
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, [showError]);

  useEffect(() => {
    if (!error) return undefined;
    const handleKeyDown = (event) => {
      if (event.key !== "Escape" && event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      closeError();
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeError, error]);

  const value = useMemo(() => ({ showError }), [showError]);
  return (
    <ErrorDialogContext.Provider value={value}>
      {children}
      {error && (
        <div className="modal-backdrop error-dialog-backdrop" role="presentation">
          <section className="save-dialog error-dialog" role="alertdialog" aria-modal="true" aria-labelledby="error-dialog-title">
            <h3 id="error-dialog-title">{error.title}</h3>
            <p>{error.message}</p>
            <div className="save-dialog-actions">
              <button type="button" className="primary-button" autoFocus onClick={closeError}>OK</button>
            </div>
          </section>
        </div>
      )}
    </ErrorDialogContext.Provider>
  );
}

export const useErrorDialog = () => {
  const context = useContext(ErrorDialogContext);
  if (!context) throw new Error("useErrorDialog must be used inside ErrorDialogProvider.");
  return context;
};
