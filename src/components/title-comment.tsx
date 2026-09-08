"use client";
import { useEffect, useRef, useState } from "react";
import { api, useInteractive } from "./client";
import { CommentComposer } from "./comment-composer";

export function TitleCommentComposer({
  titleId,
  refresh,
}: {
  titleId: string | null;
  refresh: () => Promise<void>;
}) {
  const interactive = useInteractive();
  const [draft, setDraft] = useState({ body: "", spoiler: false });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) area.current?.focus();
  }, [open]);
  // Keep drafts through refresh failures, while hiding unavailable content.
  if (!titleId) return null;
  async function post(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
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
    <section
      className="title-comment-composer"
      aria-label="Start a conversation"
    >
      <button
        type="button"
        id="title-comment-action"
        className="text-button"
        disabled={!interactive}
        aria-expanded={open}
        aria-controls="title-comment-form"
        onClick={() => {
          setOpen(true);
          if (open) area.current?.focus();
        }}
      >
        Start a conversation
      </button>
      {open && (
        <CommentComposer
          id="title-comment"
          inputRef={area}
          interactive={interactive}
          label="New title comment"
          fieldLabel="Your comment"
          submitLabel="Post comment"
          draft={draft}
          onChange={(change) =>
            setDraft((current) => ({ ...current, ...change }))
          }
          onSubmit={post}
          onCancel={() => {
            setOpen(false);
            document.getElementById("title-comment-action")?.focus();
          }}
          busy={busy}
          error={error}
        >
          <p className="small muted">
            Post a comment about this title. Only you and your friends can see
            it.
          </p>
        </CommentComposer>
      )}
    </section>
  );
}
