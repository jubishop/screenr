"use client";
import { useId, useRef, useState } from "react";
import { useInteractive } from "./client";
import { ActionButton } from "./action-button";

export function InvitationLink({ url }: { url: string }) {
  const interactive = useInteractive();
  const input = useRef<HTMLInputElement>(null);
  const hint = useId();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function copy() {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Link copied.");
    } catch {
      input.current?.focus();
      input.current?.select();
      setMessage(
        "Could not copy automatically. Select the link and copy it manually.",
      );
    } finally {
      setPending(false);
    }
  }

  async function share() {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      await navigator.share({ title: "Join me on Screenr", url });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        setMessage("Could not share this link. Copy it and share it manually.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="invitation-created">
      <label>
        Invitation link
        <input
          ref={input}
          disabled={!interactive}
          readOnly
          value={url}
          aria-describedby={hint}
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => {
            event.currentTarget.select();
            void copy();
          }}
        />
      </label>
      <div className="invitation-actions">
        <ActionButton
          type="button"
          className="secondary"
          disabled={!interactive}
          unavailable={pending}
          onClick={() => void copy()}
        >
          Copy link
        </ActionButton>
        {interactive && typeof navigator.share === "function" && (
          <ActionButton
            type="button"
            className="secondary"
            aria-label="Share invitation"
            unavailable={pending}
            onClick={() => void share()}
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 15V3m-4 4 4-4 4 4M7 11H4v10h16V11h-3" />
            </svg>
            Share
          </ActionButton>
        )}
      </div>
      <p id={hint} className="small muted">
        Tap the link or use Copy link to share it with your friends.
      </p>
      <p className="small" role="status">
        {message}
      </p>
    </div>
  );
}
