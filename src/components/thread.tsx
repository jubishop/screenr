"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type { Comment, Person, Thread } from "../shared";
import { api, useInteractive, dateLabel } from "./client";

export function ThreadView({
  snapshot,
  user,
  refresh,
}: {
  snapshot: Thread | null;
  user: Person;
  refresh: () => Promise<void>;
}) {
  const interactive = useInteractive();
  const [known, setKnown] = useState<Set<string> | null>(() =>
    snapshot ? new Set(snapshot.comments.map((c) => c.id)) : null,
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
  const knownIds = known ?? new Set(currentSnapshot.comments.map((c) => c.id));
  if (!known) setKnown(knownIds);
  const { body, spoiler, replyTo } = draft;
  const activeReplyTo = currentSnapshot.comments.find(
    (c) => c.id === replyTo && !c.removed,
  );
  const visible = currentSnapshot.comments.filter(
    (c) => knownIds.has(c.id) || c.author_id === user.user_id,
  );
  const incoming = currentSnapshot.comments.filter(
    (c) => !knownIds.has(c.id) && c.author_id !== user.user_id,
  );
  const roots = visible.filter((c) => !c.root_id);
  const missingRoots = [
    ...new Set(
      visible
        .filter((c) => c.root_id && !visible.some((r) => r.id === c.root_id))
        .map((c) => c.root_id!),
    ),
  ];
  function loadReplies() {
    const anchor = Array.from(
      document.querySelectorAll<HTMLElement>("[data-comment-id]"),
    ).find((node) => node.getBoundingClientRect().bottom > 0);
    const top = anchor?.getBoundingClientRect().top;
    setKnown(new Set(currentSnapshot.comments.map((c) => c.id)));
    requestAnimationFrame(() => {
      if (anchor?.isConnected && top !== undefined)
        window.scrollBy(0, anchor.getBoundingClientRect().top - top);
    });
  }
  async function post(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>("comment", {
        conversation: currentSnapshot.conversation.id,
        body,
        spoiler,
        replyTo: activeReplyTo?.id,
      });
      setKnown((ids) => new Set([...(ids ?? []), result.id]));
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
            {currentSnapshot.conversation.owner_id === user.user_id && (
              <button
                className="text-button muted"
                disabled={busy || !interactive}
                onClick={async () => {
                  setBusy(true);
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
                Remove
              </button>
            )}
          </div>
        )}
      </article>
    );
  }
  return (
    <section aria-label="Conversation" className="thread">
      <div className="section-heading">
        <h2>Conversation</h2>
        <span className="muted">
          {visible.filter((c) => !c.removed).length} replies
        </span>
      </div>
      {incoming.length > 0 && (
        <button className="new-replies" onClick={loadReplies}>
          New replies ({incoming.length})
        </button>
      )}
      {visible.length === 0 && (
        <p className="empty">Be the first to say something.</p>
      )}
      {roots.map((root) => (
        <div className="comment-group" key={root.id}>
          {renderComment(root)}
          <div className="nested">
            {visible.filter((c) => c.root_id === root.id).map(renderComment)}
          </div>
        </div>
      ))}
      {missingRoots.map((root) => (
        <div className="comment-group" key={root}>
          <p className="muted">Earlier comment unavailable</p>
          <div className="nested">
            {visible.filter((c) => c.root_id === root).map(renderComment)}
          </div>
        </div>
      ))}
      <form className="composer" onSubmit={post}>
        {activeReplyTo && (
          <p className="small">
            Replying to {activeReplyTo.display_name}{" "}
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
        <label htmlFor="reply">Add your reply</label>
        <textarea
          disabled={!interactive}
          ref={area}
          id="reply"
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
