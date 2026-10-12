"use client";
import { useEffect, useRef, useState } from "react";

// A result shown on the page an action opens, such as "You blocked Maya
// Chen." on Friends after Block hides the profile. It lives in memory for the
// next client navigation only, so a reload or a later visit omits it.
let next: { path: string; message: string } | null = null;

export function leaveNotice(path: string, message: string) {
  next = { path, message };
}

// The notice takes focus, so a reader hears the result where the action left
// them. Dismiss removes it and calls `onDismiss` to place focus.
export function PageNotice({
  path,
  onDismiss,
}: {
  path: string;
  onDismiss: () => void;
}) {
  const [message, setMessage] = useState("");
  const text = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (next?.path !== path) return;
    setMessage(next.message);
    next = null;
  }, [path]);
  useEffect(() => {
    if (message) text.current?.focus();
  }, [message]);
  if (!message) return null;
  return (
    <div className="page-notice">
      <p ref={text} tabIndex={-1}>
        {message}
      </p>
      <button
        type="button"
        className="text-button"
        onClick={() => {
          setMessage("");
          onDismiss();
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
