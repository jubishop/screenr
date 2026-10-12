"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FeedItem, Person, SaveSurface } from "../shared";
import { api, useInteractive } from "./client";
import { Poster } from "./poster";
import { ThreadView } from "./thread";
import { preservePosition } from "./position";
import { Reactions } from "./reactions";
import { Icon } from "./icons";
import { Avatar } from "./avatar";
import { useActionError } from "./action-error";
import { ActivityTime } from "./activity-time";
import { titleDetails } from "./title-card";

type Known = Map<string, { activity: string; comments: Set<string> }>;
function capture(items: FeedItem[]): Known {
  return new Map(
    items.map((c) => [
      c.id,
      {
        activity: c.activity_at,
        comments: new Set(c.comments.map((r) => r.id)),
      },
    ]),
  );
}
export function FeedView({
  snapshot,
  user,
  refresh,
  activity,
  busy,
  target,
  unavailable,
  showEmpty,
}: {
  snapshot: FeedItem[] | null;
  user: Person;
  refresh: () => Promise<void>;
  activity: (
    title: string,
    field: string,
    value: boolean,
    surface?: SaveSurface,
  ) => Promise<unknown>;
  busy: boolean;
  target: { item: string; reply?: string } | null;
  unavailable: boolean;
  showEmpty: boolean;
}) {
  const [known, setKnown] = useState<Known | null>(() =>
    snapshot ? capture(snapshot) : null,
  );
  // Keep only identities when access is unavailable. The current authorized
  // snapshot is always the source of rendered server content.
  const [slots, setSlots] = useState(() => snapshot?.map((c) => c.id) ?? []);
  const accepted = known ?? capture(snapshot ?? []);
  if (!known && snapshot) setKnown(accepted);
  const newSlots =
    snapshot?.filter((c) => !slots.includes(c.id)).map((c) => c.id) ?? [];
  if (newSlots.length) setSlots([...slots, ...newSlots]);
  const incoming =
    snapshot?.filter(
      (c) =>
        (c.owner_id !== user.user_id &&
          (!accepted.has(c.id) ||
            accepted.get(c.id)!.activity !== c.activity_at)) ||
        c.comments.some(
          (r) =>
            !r.removed &&
            !r.unavailable &&
            r.author_id !== user.user_id &&
            !accepted.get(c.id)?.comments.has(r.id),
        ),
    ) ?? [];
  const visible = (snapshot ?? [])
    .flatMap((c) => {
      const previous = accepted.get(c.id);
      if (!previous && c.owner_id !== user.user_id) return [];
      const acceptedComments = c.comments.filter(
        (r) => previous?.comments.has(r.id) || r.author_id === user.user_id,
      );
      // Every accepted child needs its parent, including own replies posted
      // in another tab. Keep unrelated incoming groups behind New activity.
      const roots = new Set(
        acceptedComments
          .filter((r) => !r.removed && !r.unavailable)
          .map((r) => r.root_id),
      );
      const comments = c.comments.filter(
        (r) =>
          roots.has(r.id) ||
          (!r.removed && !r.unavailable && acceptedComments.includes(r)),
      );
      if (
        !c.active &&
        !comments.some((r) => !r.removed && !r.unavailable) &&
        !(c.item_type === "earlier" && comments.length)
      )
        return [];
      const activation =
        c.owner_id === user.user_id ? c.activity_at : previous!.activity;
      const times = comments
        .filter((r) => !r.removed && !r.unavailable)
        .map((r) => Date.parse(r.created_at));
      const visibleTime =
        c.item_type === "earlier"
          ? Math.max(
              ...(times.length
                ? times
                : comments.map((r) => Date.parse(r.created_at))),
            )
          : Math.max(Date.parse(activation), ...times);
      return [
        {
          ...c,
          comments,
          visibleTime,
          visible_activity: new Date(visibleTime).toISOString(),
        },
      ];
    })
    .sort((a, b) => b.visibleTime - a.visibleTime || a.id.localeCompare(b.id));
  const order = [
    ...visible.map((c) => c.id),
    ...slots.filter((id) => !visible.some((c) => c.id === id)),
  ];
  return (
    <section className="interactive-feed" aria-label="Activity feed">
      {unavailable && <p role="status">This activity is unavailable.</p>}
      <div className="feed-updates">
        {snapshot && incoming.length > 0 && (
          <button
            className="new-replies"
            onClick={() => preservePosition(() => setKnown(capture(snapshot)))}
          >
            New activity ({incoming.length})
          </button>
        )}
      </div>
      <div className="feed-list">
        {order.map((id) => (
          <FeedEntry
            key={id}
            item={visible.find((c) => c.id === id) ?? null}
            user={user}
            refresh={refresh}
            activity={activity}
            busy={busy}
            target={target?.item === id ? target : null}
          />
        ))}
      </div>
      {snapshot && !visible.length && showEmpty && (
        <p className="empty">
          Your entries and friends’ discussions will appear here.
        </p>
      )}
    </section>
  );
}

function FeedEntry({
  item,
  user,
  refresh,
  activity,
  busy,
  target,
}: {
  item: FeedItem | null;
  user: Person;
  refresh: () => Promise<void>;
  activity: (
    title: string,
    field: string,
    value: boolean,
    surface?: SaveSurface,
  ) => Promise<unknown>;
  busy: boolean;
  target: { item: string; reply?: string } | null;
}) {
  const interactive = useInteractive();
  const [revealed, setRevealed] = useState(false);
  const hiddenSpoiler = !!item?.spoiler && !revealed;
  const navigated = useRef("");
  useEffect(() => {
    if (!target || !item) return;
    // A hidden reply links to its discussion first. Revealing the discussion
    // then reaches the reply, without repeated polls moving the reader.
    const id =
      target.reply && !hiddenSpoiler
        ? `comment-${target.reply}`
        : `item-${target.item}`;
    if (navigated.current === id) return;
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ block: "start" });
      navigated.current = id;
    }
  }, [target, item, hiddenSpoiler]);
  const [copying, setCopying] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const [deleting, setDeleting] = useState(false);
  // The title actions share one message beneath the entry's action line.
  const failure = useActionError();
  const titleURL = item ? `/titles/${item.title_id.replace(":", "/")}` : "";

  async function deleteComment() {
    if (!item || deleting) return;
    setDeleting(true);
    await failure.run("delete", async () => {
      await api("remove-comment", { id: item.id });
      await refresh();
    });
    setDeleting(false);
  }

  async function copyDiscussion() {
    if (!item || copying) return;
    setCopying(true);
    setCopyMessage("");
    try {
      await navigator.clipboard.writeText(
        new URL(`${titleURL}?item=${item.id}`, window.location.origin).href,
      );
      setCopyMessage("Link copied.");
    } catch {
      setCopyMessage("Could not copy the link. Please try again.");
    } finally {
      setCopying(false);
    }
  }

  const titleActions = item && (
    <div className="title-actions">
      {item.item_type === "comment" &&
        item.active &&
        item.owner_id === user.user_id && (
          <button
            type="button"
            className="text-button muted"
            disabled={busy || deleting || !interactive}
            aria-describedby={failure.describedBy("delete")}
            onClick={() => void deleteComment()}
          >
            {deleting ? "Deleting…" : "Delete"}
          </button>
        )}
      {item.owner_id !== user.user_id && (
        <>
          <button
            className="text-button"
            disabled={busy || !interactive}
            aria-describedby={failure.describedBy("want_to_watch")}
            onClick={() =>
              void failure.run("want_to_watch", () =>
                activity(
                  item.title_id,
                  "want_to_watch",
                  !item.viewer_want_to_watch,
                  item.item_type === "recommended" && item.active
                    ? "friend_recommendation"
                    : "friend_entry",
                ),
              )
            }
          >
            {item.viewer_want_to_watch ? "✓ Want to watch" : "+ Want to watch"}
          </button>
          <button
            className="text-button"
            disabled={busy || !interactive}
            aria-describedby={failure.describedBy("recommended")}
            onClick={() =>
              void failure.run("recommended", () =>
                activity(
                  item.title_id,
                  "recommended",
                  !item.viewer_recommended,
                ),
              )
            }
          >
            {item.viewer_recommended ? "✓ Recommended" : "+ Recommend"}
          </button>
        </>
      )}
      <span className="copy-link">
        <button
          type="button"
          className="icon-button"
          aria-label="Copy link to discussion"
          title="Copy link to discussion"
          disabled={!interactive}
          aria-disabled={copying}
          onClick={() => void copyDiscussion()}
        >
          <Icon name="link" />
        </button>
        <span className="copy-status small" role="status">
          {copyMessage}
        </span>
      </span>
    </div>
  );

  return (
    <article
      hidden={!item}
      className="feed-entry"
      data-item-id={item?.id}
      id={item ? `item-${item.id}` : undefined}
    >
      {item && (
        <header className="activity-card" data-item-heading={item.id}>
          <div className="activity-summary">
            <Link
              className="poster-link"
              href={titleURL}
              prefetch={false}
              aria-label={item.title_name}
            >
              <Poster path={item.poster_path} name={item.title_name} />
            </Link>
            <div className="activity-content">
              <p className="activity-by">
                <Avatar
                  person={{
                    user_id: item.owner_id,
                    display_name: item.display_name,
                  }}
                />
                <Link href={`/people/${item.username}`} prefetch={false}>
                  {item.display_name}
                </Link>{" "}
                <span className="muted">
                  {item.item_type === "comment"
                    ? "commented on"
                    : item.item_type === "earlier"
                      ? "· Earlier discussion"
                      : item.item_type === "recommended"
                        ? item.active
                          ? "recommends"
                          : "removed their recommendation"
                        : item.active
                          ? "wants to watch"
                          : "removed Want to watch"}
                </span>
                {/* Non-breaking spaces keep the time beside the action. */}
                <span className="muted">
                  {"\u00a0·\u00a0"}
                  <ActivityTime
                    value={item.visible_activity}
                    interactive={interactive}
                  />
                </span>
              </p>
              <h2>
                <Link href={titleURL} prefetch={false}>
                  {item.title_name}
                </Link>
              </h2>
              <p className="small muted">{titleDetails(item)}</p>
              {item.item_type === "comment" && !item.active && (
                <p className="muted">Comment removed</p>
              )}
              {hiddenSpoiler ? (
                <button className="spoiler" onClick={() => setRevealed(true)}>
                  Contains spoilers · Reveal discussion
                </button>
              ) : (
                item.body && <p className="comment-body">{item.body}</p>
              )}
            </div>
          </div>
          {!hiddenSpoiler && (item.item_type !== "comment" || item.active) ? (
            <Reactions
              item={item.id}
              summary={item.reactions}
              refresh={refresh}
            >
              {titleActions}
            </Reactions>
          ) : (
            <div className="item-actions">{titleActions}</div>
          )}
          {failure.alert}
        </header>
      )}
      <ThreadView
        snapshot={
          item && !hiddenSpoiler
            ? { conversation: item, comments: item.comments }
            : null
        }
        user={user}
        refresh={refresh}
        targetReply={target?.reply}
      />
    </article>
  );
}
