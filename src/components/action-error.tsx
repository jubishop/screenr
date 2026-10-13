"use client";
import { useId, useState } from "react";

// A failed action's message shows beside the controls that started it, as an
// alert, and describes the control that failed. Each group of controls owns
// one message: refreshes keep it, and the group's next action replaces it.
// An error's optional `details` line follows the message for copying.
export function useActionError() {
  const id = useId();
  const [failure, setFailure] = useState<{
    control: string;
    message: string;
    details?: string;
  } | null>(null);
  return {
    // Resolves whether the action succeeded.
    async run(control: string, action: () => Promise<unknown>) {
      setFailure(null);
      try {
        await action();
        return true;
      } catch (error) {
        const { message, details } = error as Error & { details?: string };
        setFailure({ control, message, details });
        return false;
      }
    },
    clear: () => setFailure(null),
    describedBy: (control: string) =>
      failure?.control === control ? id : undefined,
    alert: failure && (
      <div id={id} className="error action-error" role="alert">
        {failure.message}
        {failure.details && (
          <small className="action-error-details"> {failure.details}</small>
        )}
      </div>
    ),
  };
}
