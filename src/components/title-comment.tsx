"use client";
import { useState } from "react";
import { api, useInteractive } from "./client";

export function TitleCommentComposer({
  titleId,
  refresh,
}: {
  titleId: string | null;
  refresh: () => Promise<void>;
}) {
  const interactive = useInteractive();
  const [draft, setDraft] = useState({ body: "", spoiler: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Keep drafts through refresh failures, while hiding unavailable content.
  if (!titleId) return null;
  async function post(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("title-comment", { title: titleId, ...draft });
      setDraft((current) =>
        current === draft ? { body: "", spoiler: false } : current,
      );
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="title-comment-composer"
      aria-label="New title comment"
      onSubmit={post}
    >
      <h2>Start a discussion</h2>
      <p className="small muted">
        Post a comment about this title. Only you and your friends can see it.
      </p>
      <label htmlFor="title-comment">Your comment</label>
      <textarea
        id="title-comment"
        required
        maxLength={2000}
        disabled={!interactive}
        value={draft.body}
        placeholder="What do you think?"
        onChange={(e) =>
          setDraft((current) => ({ ...current, body: e.target.value }))
        }
      />
      <div className="composer-footer">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={draft.spoiler}
            disabled={!interactive}
            onChange={(e) =>
              setDraft((current) => ({ ...current, spoiler: e.target.checked }))
            }
          />
          Contains spoilers
        </label>
        <button
          className="primary"
          disabled={busy || !interactive || !draft.body.trim()}
        >
          {busy ? "Posting…" : "Post comment"}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
