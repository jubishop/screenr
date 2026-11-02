"use client";
import { useEffect, useRef, useState } from "react";

// A result shown on the page an action opens, such as "You blocked Maya
// Chen." on Friends after Block hides the profile. It lives in memory for the
// next screen only, so a reload omits it, and so does a later visit after
// another page opens first, such as when the reader leaves before Friends
// loads.
let next: { path: string; message: string } | null = null;

export function leaveNotice(path: string, message: string) {
  next = { path, message };
}

// Each new screen calls this with its path, dropping a notice left for
// another page. A notice for this one stays until its PageNotice shows it.
export function screenOpened(path: string) {
  if (next?.path !== path) next = null;
}

// The notice takes focus, so keyboard users continue from the result where
// the action left them. Dismiss removes it and calls `onDismiss` to place
// focus.
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
