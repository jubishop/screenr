"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FeedItem, Person } from "../shared";
import { dateLabel, useInteractive } from "./client";
import { Poster } from "./poster";
import { ThreadView } from "./thread";
import { preservePosition } from "./position";

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
  activity: (title: string, field: string, value: boolean) => Promise<unknown>;
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
            r.author_id !== user.user_id &&
            !accepted.get(c.id)?.comments.has(r.id),
        ),
    ) ?? [];
  const visible = (snapshot ?? [])
    .flatMap((c) => {
      const previous = accepted.get(c.id);
      if (!previous && c.owner_id !== user.user_id) return [];
      const comments = c.comments.filter(
        (r) => previous?.comments.has(r.id) || r.author_id === user.user_id,
      );
      if (
        !c.active &&
        !comments.some((r) => !r.removed) &&
        !(c.item_type === "earlier" && comments.length)
      )
        return [];
      const activation =
        c.owner_id === user.user_id ? c.activity_at : previous!.activity;
      const times = comments
        .filter((r) => !r.removed)
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
  const navigated = useRef("");
  useEffect(() => {
    if (!target || !snapshot) return;
    const key = `${target.item}:${target.reply ?? ""}`;
    if (navigated.current === key) return;
    const element = document.getElementById(
      target.reply ? `comment-${target.reply}` : `item-${target.item}`,
    );
    if (element) {
      element.scrollIntoView({ block: "start" });
      navigated.current = key;
    }
  }, [target, snapshot]);
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
            targetReply={target?.item === id ? target.reply : undefined}
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
  targetReply,
}: {
  item: FeedItem | null;
  user: Person;
  refresh: () => Promise<void>;
  activity: (title: string, field: string, value: boolean) => Promise<unknown>;
  busy: boolean;
  targetReply?: string;
}) {
  const interactive = useInteractive();
  const [copying, setCopying] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  const titleURL = item ? `/titles/${item.title_id.replace(":", "/")}` : "";

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

  return (
    <article
      hidden={!item}
      className="feed-entry"
      data-item-id={item?.id}
      id={item ? `item-${item.id}` : undefined}
    >
      {item && (
        <header className="activity-card" data-item-heading={item.id}>
          <Link className="poster-link" href={titleURL} prefetch={false}>
            <Poster path={item.poster_path} name={item.title_name} />
          </Link>
          <div className="activity-content">
            <p className="activity-by">
              <Link href={`/people/${item.username}`} prefetch={false}>
                {item.display_name}
              </Link>{" "}
              <span className="muted">
                {item.item_type === "earlier"
                  ? "· Earlier discussion"
                  : item.item_type === "recommended"
                    ? item.active
                      ? "recommends"
                      : "removed their recommendation"
                    : item.active
                      ? "wants to watch"
                      : "removed Want to watch"}
              </span>
            </p>
            <h2>
              <Link href={titleURL} prefetch={false}>
                {item.title_name}
              </Link>
            </h2>
            <p className="small muted">
              {item.kind === "tv" ? "TV show" : "Movie"} ·{" "}
              <time dateTime={item.visible_activity}>
                {dateLabel(item.visible_activity, interactive)}
              </time>
            </p>
            <div className="inline-actions">
              <button
                type="button"
                className="text-button conversation-link"
                disabled={!interactive}
                aria-disabled={copying}
                onClick={() => void copyDiscussion()}
              >
                Copy link to discussion
              </button>
              {item.owner_id !== user.user_id && (
                <button
                  className="text-button"
                  disabled={busy || !interactive}
                  onClick={() =>
                    void activity(
                      item.title_id,
                      "want_to_watch",
                      !item.viewer_want_to_watch,
                    )
                  }
                >
                  {item.viewer_want_to_watch
                    ? "✓ Want to watch"
                    : "+ Want to watch"}
                </button>
              )}
            </div>
            <p className="small" role="status">
              {copyMessage}
            </p>
          </div>
        </header>
      )}
      <ThreadView
        snapshot={item ? { conversation: item, comments: item.comments } : null}
        user={user}
        refresh={refresh}
        targetReply={targetReply}
      />
    </article>
  );
}
