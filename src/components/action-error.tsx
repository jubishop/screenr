"use client";
import { useId, useState } from "react";

// A failed action's message shows beside the controls that started it, as an
// alert, and describes the control that failed. Each group of controls owns
// one message: refreshes keep it, and the group's next action replaces it.
export function useActionError() {
  const id = useId();
  const [failure, setFailure] = useState<{
    control: string;
    message: string;
  } | null>(null);
  return {
    // Resolves whether the action succeeded.
    async run(control: string, action: () => Promise<unknown>) {
      setFailure(null);
      try {
        await action();
        return true;
      } catch (error) {
        setFailure({ control, message: (error as Error).message });
        return false;
      }
    },
    clear: () => setFailure(null),
    describedBy: (control: string) =>
      failure?.control === control ? id : undefined,
    alert: failure && (
      <div id={id} className="error action-error" role="alert">
        {failure.message}
      </div>
    ),
  };
}
