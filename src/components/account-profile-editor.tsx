"use client";
import { useRef, useState } from "react";
import type { Person } from "../shared";
import { useInteractive } from "./client";

export function AccountProfileEditor({
  user,
  save,
}: {
  user: Person;
  save: (name: string, username: string) => Promise<void>;
}) {
  const interactive = useInteractive();
  const [draft, setDraft] = useState<{ name: string; username: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  function close() {
    setDraft(null);
    setError("");
    requestAnimationFrame(() => editButton.current?.focus());
  }
  const valid =
    draft &&
    draft.name.trim().length > 0 &&
    draft.name.trim().length <= 60 &&
    /^[a-zA-Z0-9_]{3,24}$/.test(draft.username.trim());
  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !draft || !valid) return;
    setBusy(true);
    setError("");
    try {
      await save(draft.name, draft.username);
      close();
      setSaved(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="settings-card account-profile"
      aria-labelledby="account-profile-heading"
    >
      <h2 id="account-profile-heading">Your profile</h2>
      {draft ? (
        <form
          className="display-name-editor"
          aria-label="Edit profile"
          onSubmit={submit}
        >
          <label>
            Display name
            <input
              autoFocus
              required
              maxLength={60}
              autoComplete="name"
              value={draft.name}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          <label>
            Username
            <input
              required
              maxLength={24}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              aria-describedby="username-help"
              value={draft.username}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...draft, username: event.target.value })
              }
            />
          </label>
          <p id="username-help" className="small muted">
            Use 3–24 letters, numbers, or underscores. Usernames are saved in
            lowercase. Changing your username changes your profile link.
          </p>
          <div className="inline-actions">
            <button className="primary" disabled={busy || !valid}>
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
      ) : (
        <>
          <p>
            <strong>{user.display_name}</strong>
            <br />
            <span className="muted">@{user.username}</span>
          </p>
          <button
            ref={editButton}
            className="secondary"
            disabled={!interactive}
            onClick={() => {
              setDraft({ name: user.display_name, username: user.username });
              setError("");
              setSaved(false);
            }}
          >
            Edit profile
          </button>
          {saved && (
            <p className="small" role="status">
              Profile saved.
            </p>
          )}
        </>
      )}
    </section>
  );
}
