"use client";
import { useRef, useState, type ReactNode } from "react";
import { useInteractive } from "./client";
import { ActionButton } from "./action-button";

// Children render under the name, above the form while editing.
export function DisplayNameEditor({
  name,
  save,
  children,
}: {
  name: string;
  save: (name: string) => Promise<void>;
  children?: ReactNode;
}) {
  const interactive = useInteractive();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const restoreFocus = useRef(false);
  function close() {
    restoreFocus.current = true;
    setEditing(false);
    setError("");
  }
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !draft.trim() || draft.trim().length > 60) return;
    setBusy(true);
    setError("");
    try {
      await save(draft);
      close();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="profile-name">
        <h1>{name}</h1>
        {!editing && (
          <button
            ref={(button) => {
              if (button && restoreFocus.current) {
                restoreFocus.current = false;
                button.focus();
              }
            }}
            className="text-button"
            disabled={!interactive}
            onClick={() => {
              setDraft(name);
              setError("");
              setEditing(true);
            }}
          >
            Edit display name
          </button>
        )}
      </div>
      {children}
      {editing && (
        <form
          className="display-name-editor"
          aria-label="Edit display name"
          onSubmit={submit}
        >
          <label>
            Display name
            <input
              autoFocus
              required
              maxLength={60}
              autoComplete="name"
              value={draft}
              readOnly={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className="inline-actions">
            <ActionButton
              className="primary"
              unavailable={busy || !draft.trim()}
            >
              {busy ? "Saving…" : "Save"}
            </ActionButton>
            <ActionButton
              className="secondary"
              type="button"
              unavailable={busy}
              onClick={close}
            >
              Cancel
            </ActionButton>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </>
  );
}
