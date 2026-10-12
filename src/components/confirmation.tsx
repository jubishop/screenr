"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";

// The in-page confirmation for destructive actions; never a browser dialog.
// It states the effect, then offers the action and Cancel. Cancel takes focus,
// so a reader hears the question and an accidental Enter changes nothing.
// A failed action's message, `children`, follows the buttons and describes
// the action through `describedBy`.
export function Confirmation({
  message,
  action,
  busy,
  onConfirm,
  onCancel,
  describedBy,
  children,
}: {
  message: string;
  action: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  describedBy?: string;
  children?: ReactNode;
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
          aria-describedby={describedBy}
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
      {children}
    </div>
  );
}
