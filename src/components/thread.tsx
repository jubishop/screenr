"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type { Comment, Person, Thread } from "../shared";
import { api, useInteractive, dateLabel } from "./client";
import { preservePosition } from "./position";
import { Reactions } from "./reactions";

export function ThreadView({
  snapshot,
  user,
  refresh,
  targetReply,
}: {
  snapshot: Thread | null;
  user: Person;
  refresh: () => Promise<void>;
  targetReply?: string;
}) {
  const interactive = useInteractive();
  const [expanded, setExpanded] = useState(false);
  const [previewIds, setPreviewIds] = useState<string[] | null>(() =>
    snapshot?.comments.length
      ? snapshot.comments.slice(-3).map((c) => c.id)
      : null,
  );
  const [revealed, setRevealed] = useState(new Set<string>());
  const [draft, setDraft] = useState({
    body: "",
    spoiler: false,
    replyTo: null as string | null,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  // Keep local composition state through a failed refresh, but render no
  // conversation content until a current authorized snapshot is available.
  if (!snapshot) return null;
  const currentSnapshot = snapshot;
  const { body, spoiler, replyTo } = draft;
  const activeReplyTo = currentSnapshot.comments.find(
    (c) => c.id === replyTo && !c.removed,
  );
  const comments = currentSnapshot.comments;
  const showAll = expanded || !!targetReply;
  // Keep the displayed preview while new replies arrive. Replacing it with
  // a new slice of three can remove the reader's anchor during New activity.
  const initialPreview = previewIds ?? comments.slice(-3).map((c) => c.id);
  if (!previewIds && comments.length) setPreviewIds(initialPreview);
  const start = showAll
    ? 0
    : Math.min(
        Math.max(0, comments.length - 3),
        ...initialPreview
          .map((id) => comments.findIndex((c) => c.id === id))
          .filter((index) => index >= 0),
      );
  const visible = comments.slice(start);
  async function post(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api<{ id: string }>("comment", {
        conversation: currentSnapshot.conversation.id,
        body,
        spoiler,
        replyTo: replyTo ?? undefined,
      });
      setDraft((current) =>
        current === draft
          ? { body: "", spoiler: false, replyTo: null }
          : current,
      );
      await refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function renderComment(comment: Comment) {
    return (
      <article
        className="comment"
        key={comment.id}
        data-comment-id={comment.id}
        id={`comment-${comment.id}`}
      >
        <div className="comment-heading">
          <Link href={`/people/${comment.username}`} prefetch={false}>
            <strong>{comment.display_name}</strong>{" "}
            <span className="muted">@{comment.username}</span>
          </Link>
          <time className="small muted" dateTime={comment.created_at}>
            {dateLabel(comment.created_at, interactive, {
              month: "short",
              day: "numeric",
            })}
          </time>
          <Link
            className="small muted"
            aria-label="Link to reply"
            href={`/titles/${currentSnapshot.conversation.title_id.replace(":", "/")}?item=${currentSnapshot.conversation.id}&reply=${comment.id}`}
            prefetch={false}
          >
            ↗
          </Link>
        </div>
        {comment.addressed_username && (
          <p className="small muted">
            Replying to @{comment.addressed_username}
          </p>
        )}
        {comment.removed ? (
          <p className="muted">Comment removed</p>
        ) : comment.spoiler && !revealed.has(comment.id) ? (
          <button
            className="spoiler"
            onClick={() => setRevealed((ids) => new Set([...ids, comment.id]))}
          >
            Contains spoilers · Reveal comment
          </button>
        ) : (
          <p className="comment-body">{comment.body}</p>
        )}
        {!comment.removed && (
          <div className="inline-actions">
            <button
              className="text-button"
              disabled={!interactive}
              onClick={() => {
                setDraft((current) => ({ ...current, replyTo: comment.id }));
                area.current?.focus();
              }}
            >
              Reply
            </button>
            {(comment.author_id === user.user_id ||
              currentSnapshot.conversation.owner_id === user.user_id) && (
              <button
                className="text-button muted"
                disabled={busy || !interactive}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await api("remove-comment", { id: comment.id });
                    await refresh();
                  } catch (error) {
                    setError((error as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {comment.author_id === user.user_id ? "Delete" : "Remove"}
              </button>
            )}
          </div>
        )}
        {!comment.removed && (!comment.spoiler || revealed.has(comment.id)) && (
          <Reactions
            item={currentSnapshot.conversation.id}
            reply={comment.id}
            summary={comment.reactions}
            refresh={refresh}
          />
        )}
      </article>
    );
  }
  return (
    <section aria-label="Conversation" className="thread">
      <div className="section-heading">
        <h2>Conversation</h2>
        <span className="muted">
          {comments.filter((c) => !c.removed).length} replies
        </span>
      </div>
      {start > 0 && (
        <button
          className="text-button"
          onClick={() => preservePosition(() => setExpanded(true))}
        >
          Show earlier replies ({start})
        </button>
      )}
      {visible.length === 0 && <p className="empty">Be the first to reply.</p>}
      <div className="replies">{visible.map(renderComment)}</div>
      <form
        className="composer"
        data-composer-id={currentSnapshot.conversation.id}
        onSubmit={post}
      >
        {replyTo && (
          <p className="small">
            {activeReplyTo
              ? `Replying to ${activeReplyTo.display_name}`
              : "Reply target unavailable."}{" "}
            <button
              type="button"
              className="text-button"
              disabled={!interactive}
              onClick={() =>
                setDraft((current) => ({ ...current, replyTo: null }))
              }
            >
              Cancel
            </button>
          </p>
        )}
        <label htmlFor={`reply-${currentSnapshot.conversation.id}`}>
          Add your reply
        </label>
        <textarea
          disabled={!interactive}
          ref={area}
          id={`reply-${currentSnapshot.conversation.id}`}
          required
          maxLength={2000}
          value={body}
          onChange={(e) =>
            setDraft((current) => ({ ...current, body: e.target.value }))
          }
          placeholder="What do you think?"
        />
        <div className="composer-footer">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={spoiler}
              onChange={(e) =>
                setDraft((current) => ({
                  ...current,
                  spoiler: e.target.checked,
                }))
              }
            />
            Contains spoilers
          </label>
          <button
            className="primary"
            disabled={busy || !interactive || !body.trim()}
          >
            {busy ? "Posting…" : "Post reply"}
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}
