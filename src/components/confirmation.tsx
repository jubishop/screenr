"use client";
import { useEffect, useId, useRef } from "react";

// The in-page confirmation for destructive actions; never a browser dialog.
// It states the effect, then offers the action and Cancel. Cancel takes focus,
// so a reader hears the question and an accidental Enter changes nothing.
export function Confirmation({
  message,
  action,
  busy,
  onConfirm,
  onCancel,
}: {
  message: string;
  action: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const question = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <div className="confirmation" role="group" aria-labelledby={question}>
      <p id={question}>{message}</p>
      <div className="confirmation-actions">
        <button
          type="button"
          className="danger"
          disabled={busy}
          onClick={onConfirm}
        >
          {action}
        </button>
        <button
          type="button"
          className="secondary"
          ref={cancel}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
