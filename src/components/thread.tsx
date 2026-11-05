"use client";
import { Link } from "./pending-navigation";
import { useEffect, useRef, useState } from "react";
import type { Comment, Person, Thread } from "../shared";
import { memberPath } from "../member-routes";
import { api, useInteractive } from "./client";
import { ActivityTime } from "./activity-time";
import { preservePosition } from "./position";
import { Reactions } from "./reactions";
import { Avatar } from "./avatar";
import { ConfirmAction } from "./confirmation";
import { around, useRemovalFocus, type FocusTarget } from "./removal-focus";
import {
  CommentComposer,
  type CommentDraft as Draft,
} from "./comment-composer";

const emptyDraft: Draft = { body: "", spoiler: false };
export const live = (comment: Comment) =>
  !comment.removed && !comment.unavailable;
// A reader can Delete their own comment and Remove any comment under their
// entry.
export const removable = (
  comment: Comment,
  conversation: Thread["conversation"],
  user: Person,
) =>
  comment.author_id === user.user_id || conversation.owner_id === user.user_id;

// While a failed read hides the conversation, `available` is false and the
// thread shows only an open Delete or Remove confirmation, from the last
// snapshot, whose action waits for the next read. The entry owns which
// comment is `confirming`, so it can show that confirmation alone.
export function ThreadView({
  snapshot,
  available,
  confirming,
  setConfirming,
  user,
  refresh,
  targetReply,
  entryFocus,
}: {
  snapshot: Thread | null;
  available: boolean;
  // The comment whose Delete or Remove waits for confirmation.
  confirming: string | null;
  setConfirming: (comment: string | null) => void;
  user: Person;
  refresh: () => Promise<void>;
  targetReply?: string;
  // Where focus goes when no comment is left to take it.
  entryFocus: () => FocusTarget[];
}) {
  const interactive = useInteractive();
  const [expanded, setExpanded] = useState(false);
  const [previewIds, setPreviewIds] = useState<string[] | null>(null);
  const [groups, setGroups] = useState(new Map<string, boolean>());
  const [revealed, setRevealed] = useState(new Set<string>());
  // Each destination owns its draft. Switching or cancelling never retargets
  // unsent text, and temporarily losing access never copies server identities.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [directOpen, setDirectOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const thread = useRef<HTMLElement>(null);
  const removalFocus = useRemovalFocus();
  const area = useRef<HTMLTextAreaElement>(null);
  const directArea = useRef<HTMLTextAreaElement>(null);
  // Focus only when a reader opens a destination, not when a failed refresh
  // restores the same open forms.
  useEffect(() => {
    area.current?.focus();
  }, [replyTo]);
  useEffect(() => {
    if (directOpen) directArea.current?.focus();
  }, [directOpen]);
  // Keep local composition state through failed refreshes. Only the current
  // authorized snapshot supplies rendered conversation content.
  if (!snapshot || (!available && !confirming)) return null;
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
  const replyCount = comments.filter(live).length;

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
      await api("comment", {
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
    if (!available) return null;
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
      <CommentComposer
        id={id}
        inputRef={nested ? area : directArea}
        interactive={interactive}
        label={label}
        fieldLabel={nested ? "Your nested reply" : "Add your reply"}
        submitLabel="Post reply"
        draft={draft}
        onChange={update}
        onSubmit={(event) => post(event, destination)}
        onCancel={() => {
          if (nested) setReplyTo(null);
          else setDirectOpen(false);
          document
            .getElementById(
              nested
                ? `reply-action-${destination}`
                : `comment-action-${currentSnapshot.conversation.id}`,
            )
            ?.focus();
        }}
        busy={busy.has(destination)}
        error={errors[destination] ?? ""}
        disabled={nested && !activeReply}
        nested={nested}
      >
        {nested && <p className="small">{label}</p>}
      </CommentComposer>
    );
  }
  const canRemove = (comment: Comment) =>
    removable(comment, currentSnapshot.conversation, user);
  const removal = (comment: Comment) =>
    comment.author_id === user.user_id ? "Delete" : "Remove";
  function commentActions(comment: Comment) {
    return (
      <>
        <button
          className="text-button"
          id={`reply-action-${comment.id}`}
          aria-expanded={replyTo === comment.id}
          aria-controls={`reply-${currentSnapshot.conversation.id}-${comment.id}-form`}
          disabled={!interactive}
          onClick={() => {
            setReplyTo(comment.id);
            if (replyTo === comment.id) area.current?.focus();
          }}
        >
          Reply
        </button>
        {canRemove(comment) && (
          <button
            className="text-button muted"
            id={`remove-action-${comment.id}`}
            disabled={!interactive}
            onClick={() => setConfirming(comment.id)}
          >
            {removal(comment)}
          </button>
        )}
      </>
    );
  }
  function renderComment(comment: Comment) {
    if (!available && comment.id !== confirming) return null;
    // Comments without an available author show a neutral placeholder. A
    // removed comment whose author deleted their account has no author but
    // is not unavailable; its heading alone says it was removed.
    const deletedAuthor = !comment.unavailable && !comment.author_id;
    const author =
      !comment.unavailable && comment.author_id
        ? {
            user_id: comment.author_id,
            display_name: comment.display_name ?? "",
            photo: comment.photo,
          }
        : null;
    return (
      <article
        className="comment"
        data-comment-id={comment.id}
        id={`comment-${comment.id}`}
        aria-labelledby={available ? `author-${comment.id}` : undefined}
        // A removal can move focus to the nearest comment.
        tabIndex={-1}
      >
        {available && (
          <>
            <div className="comment-heading">
              <span className="comment-author" id={`author-${comment.id}`}>
                <Avatar person={author} />
                {author ? (
                  <Link
                    href={memberPath({
                      kind: "profile",
                      username: comment.username ?? "",
                    })}
                    prefetch={false}
                  >
                    <strong>{comment.display_name}</strong>{" "}
                    <span className="muted">@{comment.username}</span>
                  </Link>
                ) : (
                  <span className="muted">
                    {deletedAuthor ? "Comment removed" : "Comment unavailable"}
                  </span>
                )}
              </span>
              {!comment.unavailable && (
                <ActivityTime
                  className="small muted"
                  value={comment.created_at}
                  interactive={interactive}
                />
              )}
            </div>
            {!comment.unavailable && comment.addressed_username && (
              <p className="small muted">
                Replying to @{comment.addressed_username}
              </p>
            )}
            {comment.unavailable || deletedAuthor ? null : comment.removed ? (
              <p className="muted" id={`removed-${comment.id}`} tabIndex={-1}>
                Comment removed
              </p>
            ) : comment.spoiler && !revealed.has(comment.id) ? (
              <button
                className="spoiler"
                onClick={() =>
                  setRevealed((ids) => new Set([...ids, comment.id]))
                }
              >
                Contains spoilers · Reveal comment
              </button>
            ) : (
              <p className="comment-body">{comment.body}</p>
            )}
            {live(comment) &&
              (!comment.spoiler || revealed.has(comment.id) ? (
                <Reactions
                  item={currentSnapshot.conversation.id}
                  reply={comment.id}
                  summary={comment.reactions}
                  refresh={refresh}
                >
                  {commentActions(comment)}
                </Reactions>
              ) : (
                <div className="item-actions">{commentActions(comment)}</div>
              ))}
          </>
        )}
        {live(comment) && canRemove(comment) && confirming === comment.id && (
          <ConfirmAction
            message={`${removal(comment)} this comment? Its text will be erased.`}
            action={removal(comment)}
            unavailable={!available}
            run={async () => {
              // A comment with replies keeps its placeholder; otherwise the
              // nearest comment, in reading order, takes focus.
              removalFocus.start(
                document.getElementById(`remove-action-${comment.id}`),
                [
                  `removed-${comment.id}`,
                  ...around(
                    document.getElementById(`comment-${comment.id}`),
                    thread.current,
                    ".comment",
                  ),
                  ...entryFocus(),
                ],
              );
              await api("remove-comment", { id: comment.id });
              await refresh();
            }}
            onDone={() => {
              setConfirming(null);
              removalFocus.done();
            }}
            onCancel={() => {
              setConfirming(null);
              document.getElementById(`remove-action-${comment.id}`)?.focus();
            }}
          />
        )}
      </article>
    );
  }
  return (
    <section aria-label="Conversation" className="thread" ref={thread}>
      {comments.length > 0 && (
        <>
          {available && (
            <p className="reply-count small muted">
              {replyCount} {replyCount === 1 ? "reply" : "replies"}
            </p>
          )}
          {available && start > 0 && (
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
          <div className="replies">
            {visible.map((parent) => {
              const replies = children.get(parent.id) ?? [];
              const open =
                (groups.get(parent.id) ?? targetRoot === parent.id) ||
                replies.some((c) => c.id === replyTo);
              const holds = (c: Comment) => available || c.id === confirming;
              if (!holds(parent) && !(open && replies.some(holds))) return null;
              return (
                <div className="comment-group" key={parent.id}>
                  {renderComment(parent)}
                  {replyTo === parent.id && composer(parent.id)}
                  {replies.length > 0 && (
                    <>
                      {available && (
                        <button
                          className="text-button reply-expansion"
                          aria-expanded={open}
                          aria-controls={`replies-${parent.id}`}
                          onClick={() =>
                            preservePosition(() => {
                              setGroups((current) =>
                                new Map(current).set(parent.id, !open),
                              );
                              // Hiding replies closes what they had open.
                              if (open && replies.some((c) => c.id === replyTo))
                                setReplyTo(null);
                              if (
                                open &&
                                replies.some((c) => c.id === confirming)
                              )
                                setConfirming(null);
                            })
                          }
                        >
                          {open ? "Hide" : "View"} {replies.length}{" "}
                          {replies.length === 1 ? "reply" : "replies"}
                        </button>
                      )}
                      <div id={`replies-${parent.id}`} className="nested">
                        {open &&
                          replies.filter(holds).map((reply) => (
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
        </>
      )}
      {replyTo &&
        !visible.some(
          (c) =>
            c.id === replyTo ||
            children.get(c.id)?.some((r) => r.id === replyTo),
        ) &&
        composer(replyTo)}
      {available && (
        <button
          type="button"
          id={`comment-action-${currentSnapshot.conversation.id}`}
          className="text-button comment-action"
          disabled={!interactive}
          aria-expanded={directOpen}
          aria-controls={`reply-${currentSnapshot.conversation.id}-direct-form`}
          onClick={() => {
            setDirectOpen(true);
            if (directOpen) directArea.current?.focus();
          }}
        >
          Comment
        </button>
      )}
      {directOpen && composer("direct")}
    </section>
  );
}
