"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Comment, Person, Thread } from "../shared";
import { api, useInteractive, dateLabel } from "./client";
import { preservePosition } from "./position";

type Draft = { body: string; spoiler: boolean };
const emptyDraft: Draft = { body: "", spoiler: false };
const live = (comment: Comment) => !comment.removed && !comment.unavailable;

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
  const [previewIds, setPreviewIds] = useState<string[] | null>(null);
  const [groups, setGroups] = useState(new Map<string, boolean>());
  const [revealed, setRevealed] = useState(new Set<string>());
  // Each destination owns its draft. Switching or cancelling never retargets
  // unsent text, and temporarily losing access never copies server identities.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    area.current?.focus();
  }, [replyTo]);
  // Keep local composition state through failed refreshes. Only the current
  // authorized snapshot supplies rendered conversation content.
  if (!snapshot) return null;
  const currentSnapshot = snapshot;
  const comments = currentSnapshot.comments;
  const children = new Map<string, Comment[]>();
  for (const comment of comments) {
    if (!comment.root_id || !live(comment)) continue;
    const group = children.get(comment.root_id) ?? [];
    group.push(comment);
    children.set(comment.root_id, group);
  }
  const direct = comments.filter(
    (c) => !c.root_id && (live(c) || children.has(c.id)),
  );
  const eligible = direct.filter(live);
  // Preserve the preview's first reading anchor as new comments arrive. Only
  // live direct comments consume its three places; placeholders supply context.
  const initialPreview = previewIds ?? eligible.slice(-3).map((c) => c.id);
  if (!previewIds && eligible.length) setPreviewIds(initialPreview);
  const start =
    expanded || targetReply
      ? 0
      : Math.min(
          eligible.length < 3
            ? 0
            : direct.findIndex((c) => c.id === eligible.at(-3)!.id),
          ...initialPreview
            .map((id) => direct.findIndex((c) => c.id === id))
            .filter((index) => index >= 0),
        );
  const visible = direct.slice(start);
  const target = comments.find((c) => c.id === targetReply);
  const targetRoot = target?.root_id ?? target?.id;
  const activeReply = comments.find((c) => c.id === replyTo && live(c));

  async function post(
    event: React.SubmitEvent<HTMLFormElement>,
    destination: string,
  ) {
    event.preventDefault();
    const draft = drafts[destination] ?? emptyDraft;
    if (busy.has(destination) || (destination !== "direct" && !activeReply))
      return;
    setBusy((current) => new Set([...current, destination]));
    setErrors((current) => ({ ...current, [destination]: "" }));
    try {
      await api<{ id: string }>("comment", {
        conversation: currentSnapshot.conversation.id,
        ...draft,
        replyTo: destination === "direct" ? undefined : destination,
      });
      if (destination !== "direct" && activeReply)
        setGroups((current) =>
          new Map(current).set(activeReply.root_id ?? activeReply.id, true),
        );
      setDrafts((current) =>
        current[destination] === draft
          ? { ...current, [destination]: emptyDraft }
          : current,
      );
      await refresh();
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [destination]: (error as Error).message,
      }));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(destination);
        return next;
      });
    }
  }
  function composer(destination: string) {
    const nested = destination !== "direct";
    const draft = drafts[destination] ?? emptyDraft;
    const label = nested
      ? activeReply
        ? `Replying to @${activeReply.username}`
        : "Reply target unavailable."
      : "Reply to feed item";
    const id = `reply-${currentSnapshot.conversation.id}-${destination}`;
    const update = (change: Partial<Draft>) =>
      setDrafts((current) => ({
        ...current,
        [destination]: { ...(current[destination] ?? emptyDraft), ...change },
      }));
    return (
      <form
        className={`composer${nested ? " nested-composer" : ""}`}
        aria-label={label}
        data-composer-id={`${currentSnapshot.conversation.id}-${destination}`}
        onSubmit={(event) => post(event, destination)}
      >
        {nested && (
          <p className="small">
            {label}{" "}
            <button
              type="button"
              className="text-button"
              disabled={!interactive}
              onClick={() => {
                setReplyTo(null);
                document.getElementById(`reply-action-${destination}`)?.focus();
              }}
            >
              Cancel
            </button>
          </p>
        )}
        <label htmlFor={id}>
          {nested ? "Your nested reply" : "Add your reply"}
        </label>
        <textarea
          disabled={!interactive}
          ref={nested ? area : undefined}
          id={id}
          required
          maxLength={2000}
          value={draft.body}
          onChange={(e) => update({ body: e.target.value })}
          placeholder="What do you think?"
        />
        <div className="composer-footer">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.spoiler}
              onChange={(e) => update({ spoiler: e.target.checked })}
            />
            Contains spoilers
          </label>
          <button
            className="primary"
            disabled={
              busy.has(destination) ||
              !interactive ||
              !draft.body.trim() ||
              (nested && !activeReply)
            }
          >
            {busy.has(destination) ? "Posting…" : "Post reply"}
          </button>
        </div>
        {errors[destination] && (
          <p className="error" role="alert">
            {errors[destination]}
          </p>
        )}
      </form>
    );
  }
  function renderComment(comment: Comment) {
    return (
      <article
        className="comment"
        data-comment-id={comment.id}
        id={`comment-${comment.id}`}
      >
        {!comment.unavailable && (
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
        )}
        {!comment.unavailable && comment.addressed_username && (
          <p className="small muted">
            Replying to @{comment.addressed_username}
          </p>
        )}
        {comment.unavailable ? (
          <p className="muted">Comment unavailable</p>
        ) : comment.removed ? (
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
        {live(comment) && (
          <div className="inline-actions">
            <button
              className="text-button"
              id={`reply-action-${comment.id}`}
              disabled={!interactive}
              onClick={() => {
                setReplyTo(comment.id);
                if (replyTo === comment.id) area.current?.focus();
              }}
            >
              Reply
            </button>
            {currentSnapshot.conversation.owner_id === user.user_id && (
              <button
                className="text-button muted"
                disabled={busy.has(`remove-${comment.id}`) || !interactive}
                onClick={async () => {
                  const key = `remove-${comment.id}`;
                  setBusy((current) => new Set([...current, key]));
                  try {
                    await api("remove-comment", { id: comment.id });
                    await refresh();
                  } catch (error) {
                    setErrors((current) => ({
                      ...current,
                      direct: (error as Error).message,
                    }));
                  } finally {
                    setBusy((current) => {
                      const next = new Set(current);
                      next.delete(key);
                      return next;
                    });
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
        <span className="muted">{comments.filter(live).length} replies</span>
      </div>
      {start > 0 && (
        <button
          className="text-button"
          onClick={() => preservePosition(() => setExpanded(true))}
        >
          Show earlier comments
          {direct.slice(0, start).filter(live).length > 0
            ? ` (${direct.slice(0, start).filter(live).length})`
            : ""}
        </button>
      )}
      {visible.length === 0 && <p className="empty">Be the first to reply.</p>}
      <div className="replies">
        {visible.map((parent) => {
          const replies = children.get(parent.id) ?? [];
          const open =
            (groups.get(parent.id) ?? targetRoot === parent.id) ||
            replies.some((c) => c.id === replyTo);
          return (
            <div className="comment-group" key={parent.id}>
              {renderComment(parent)}
              {replyTo === parent.id && composer(parent.id)}
              {replies.length > 0 && (
                <>
                  <button
                    className="text-button reply-expansion"
                    aria-expanded={open}
                    aria-controls={`replies-${parent.id}`}
                    onClick={() =>
                      preservePosition(() => {
                        setGroups((current) =>
                          new Map(current).set(parent.id, !open),
                        );
                        if (open && replies.some((c) => c.id === replyTo))
                          setReplyTo(null);
                      })
                    }
                  >
                    View {replies.length}{" "}
                    {replies.length === 1 ? "reply" : "replies"}
                  </button>
                  <div id={`replies-${parent.id}`} className="nested">
                    {open &&
                      replies.map((reply) => (
                        <div key={reply.id}>
                          {renderComment(reply)}
                          {replyTo === reply.id && composer(reply.id)}
                        </div>
                      ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      {replyTo &&
        !visible.some(
          (c) =>
            c.id === replyTo ||
            children.get(c.id)?.some((r) => r.id === replyTo),
        ) &&
        composer(replyTo)}
      {composer("direct")}
    </section>
  );
}
