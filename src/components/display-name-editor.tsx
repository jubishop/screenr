"use client";
import { useRef, useState } from "react";
import { useInteractive } from "./client";

export function DisplayNameEditor({
  name,
  save,
}: {
  name: string;
  save: (name: string) => Promise<void>;
}) {
  const interactive = useInteractive();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const editButton = useRef<HTMLButtonElement>(null);
  function close() {
    setEditing(false);
    setError("");
    requestAnimationFrame(() => editButton.current?.focus());
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
            ref={editButton}
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
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
            />
          </label>
          <div className="inline-actions">
            <button className="primary" disabled={busy || !draft.trim()}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              className="secondary"
              type="button"
              disabled={busy}
              onClick={close}
            >
              Cancel
            </button>
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
