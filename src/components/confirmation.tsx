"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ActionButton } from "./action-button";
import { useActionError } from "./action-error";

// The in-page confirmation for destructive actions; never a browser dialog.
// It states the effect, then offers the action and Cancel. Cancel takes focus,
// so a reader hears the question and an accidental Enter changes nothing.
// While the action is pending, both buttons keep focus but ignore presses.
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
        <ActionButton
          type="button"
          className="danger"
          unavailable={busy}
          aria-describedby={describedBy}
          onClick={onConfirm}
        >
          {action}
        </ActionButton>
        <ActionButton
          type="button"
          className="secondary"
          ref={cancel}
          unavailable={busy}
          onClick={onCancel}
        >
          Cancel
        </ActionButton>
      </div>
      {children}
    </div>
  );
}

// A confirmation that runs its action and owns the failure message. A failed
// action stays open with the message until Cancel; success calls `onDone`.
// `busy` adds writes the caller tracks, such as the page's shared write.
export function ConfirmAction({
  message,
  action,
  busy = false,
  run,
  onDone,
  onCancel,
}: {
  message: string;
  action: string;
  busy?: boolean;
  run: () => Promise<unknown>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const failure = useActionError();
  const [pending, setPending] = useState(false);
  async function confirm() {
    setPending(true);
    const done = await failure.run(action, run);
    setPending(false);
    if (done) onDone();
  }
  return (
    <Confirmation
      message={message}
      action={action}
      busy={busy || pending}
      onConfirm={() => void confirm()}
      onCancel={onCancel}
      describedBy={failure.describedBy(action)}
    >
      {failure.alert}
    </Confirmation>
  );
}
