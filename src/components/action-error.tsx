"use client";
import { useState } from "react";

// A failed action's message shows beside the controls that started it. Each
// group of controls owns one message: refreshes keep it, and the group's next
// action replaces it. An error's optional `details` line follows the message
// for copying.
export function useActionError() {
  const [failure, setFailure] = useState<{
    message: string;
    details?: string;
  } | null>(null);
  return {
    // Resolves whether the action succeeded.
    async run(action: () => Promise<unknown>) {
      setFailure(null);
      try {
        await action();
        return true;
      } catch (error) {
        const { message, details } = error as Error & { details?: string };
        setFailure({ message, details });
        return false;
      }
    },
    clear: () => setFailure(null),
    alert: failure && (
      <div className="error action-error">
        {failure.message}
        {failure.details && (
          <small className="action-error-details"> {failure.details}</small>
        )}
      </div>
    ),
  };
}
