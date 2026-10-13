"use client";
import { Link } from "./pending-navigation";
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
import { ActionButton } from "./action-button";
import { progressPhrase, statusLabels } from "./watch-status";
import { ConfirmAction } from "./confirmation";
import { around, useRemovalFocus, type FocusTarget } from "./removal-focus";
import { ReviewStars, reviewPhrase } from "./review";
import { entryPath, memberPath } from "../member-routes";
import { leavingTopTen } from "./top-ten";

// A TV comment's label, such as "Season 2" or "Season 2, Episode 4".
function discussionLabel(season: number, episode: number | null) {
  return `Season ${season}${episode === null ? "" : `, Episode ${episode}`}`;
}

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
  compact,
  shownEntry,
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
  compact: boolean;
  shownEntry: { item: string } | null;
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
  // A friend line name can name an entry still waiting behind New activity.
  // Showing it accepts the pending activity, as New activity would.
  const [handledEntry, setHandledEntry] = useState(shownEntry);
  if (shownEntry !== handledEntry) {
    setHandledEntry(shownEntry);
    if (
      snapshot &&
      shownEntry &&
      !visible.some((c) => c.id === shownEntry.item) &&
      snapshot.some((c) => c.id === shownEntry.item)
    )
      setKnown(capture(snapshot));
  }
  return (
    <section
      className="interactive-feed"
      aria-label="Activity feed"
      // Focus moves to the feed when its last entry leaves.
      tabIndex={-1}
    >
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
            compact={compact}
            shown={shownEntry?.item === id ? shownEntry : null}
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
  compact,
  shown,
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
  compact: boolean;
  shown: { item: string } | null;
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
  // Move to an entry chosen from the friend line once it is shown, and focus
  // it so keyboard and screen reader users continue from there.
  const handledShow = useRef<object | null>(null);
  useEffect(() => {
    if (!shown || !item || handledShow.current === shown) return;
    handledShow.current = shown;
    const element = document.getElementById(`item-${item.id}`);
    element?.scrollIntoView({ block: "start" });
    element?.focus({ preventScroll: true });
  }, [shown, item]);
  const [copying, setCopying] = useState(false);
  const [copyMessage, setCopyMessage] = useState("");
  // Delete waits for its confirmation beneath the entry's action line, and so
  // does a title action that would take the title out of the reader's top 10.
  const [confirming, setConfirming] = useState<
    "delete" | "recommended" | "want_to_watch" | null
  >(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const wantButton = useRef<HTMLButtonElement>(null);
  const recommendButton = useRef<HTMLButtonElement>(null);
  const ranked = !!item?.viewer_recommended && !!item.viewer_top_ten_rank;
  const entry = useRef<HTMLElement>(null);
  const removal = useRemovalFocus();
  // Where focus goes when this entry's content leaves with its control: the
  // entry, then the nearest entry still shown, then the feed.
  const entryFocus = (): FocusTarget[] => [
    entry.current,
    ...around(entry.current, entry.current?.parentElement, ".feed-entry"),
    entry.current?.closest(".interactive-feed"),
  ];
  // The title actions share one message beneath the entry's action line.
  const failure = useActionError();
  // Every entry but a post without a title belongs to a movie or show.
  const title =
    item?.title_id && item.title_name !== null && item.kind
      ? {
          id: item.title_id,
          name: item.title_name,
          kind: item.kind,
          release_date: item.release_date ?? "",
        }
      : null;
  const titleURL = title ? memberPath({ kind: "title", id: title.id }) : "";
  // Comments and posts can be deleted, keeping their replies.
  const deletable = item?.item_type === "comment" || item?.item_type === "post";

  async function copyDiscussion() {
    if (!item || copying) return;
    setCopying(true);
    setCopyMessage("");
    try {
      await navigator.clipboard.writeText(
        new URL(entryPath(item), window.location.origin).href,
      );
      setCopyMessage("Link copied.");
    } catch {
      setCopyMessage("Could not copy the link. Please try again.");
    } finally {
      setCopying(false);
    }
  }

  const copyLink = (
    <span className="copy-link">
      <ActionButton
        type="button"
        className="icon-button"
        aria-label="Copy link to discussion"
        title="Copy link to discussion"
        disabled={!interactive}
        unavailable={copying}
        onClick={() => void copyDiscussion()}
      >
        <Icon name="link" />
      </ActionButton>
      <span className="copy-status small" role="status">
        {copyMessage}
      </span>
    </span>
  );
  // Deleted standalone comments and posts and removed reviews show no
  // reactions.
  const erased =
    (deletable || item?.item_type === "review") && !!item && !item.active;
  const canDelete =
    deletable && !!item?.active && item.owner_id === user.user_id;
  // Saving to Want to watch, or removing it, from a friend's entry.
  const saveWantToWatch = async () => {
    if (item && title)
      await activity(
        title.id,
        "want_to_watch",
        !item.viewer_want_to_watch,
        item.item_type === "recommended" && item.active
          ? "friend_recommendation"
          : "friend_entry",
      );
  };
  // Compact title page entries leave the title actions to the page header
  // and move the copy link to the author line.
  const titleActions = item && (!compact || canDelete) && (
    <div className="title-actions">
      {canDelete && (
        <button
          type="button"
          className="text-button muted"
          ref={deleteButton}
          disabled={!interactive}
          onClick={() => setConfirming("delete")}
        >
          Delete
        </button>
      )}
      {!compact && title && item.owner_id !== user.user_id && (
        <>
          {/* One tap saves to Want to watch. A reader with another status
              sees it instead, linked to the title page's status menu. */}
          {item.viewer_status && item.viewer_status !== "want_to_watch" ? (
            <Link className="text-button" href={titleURL} prefetch={false}>
              ✓ {statusLabels[item.viewer_status]}
            </Link>
          ) : (
            <ActionButton
              ref={wantButton}
              className="text-button"
              disabled={!interactive}
              unavailable={busy}
              aria-describedby={failure.describedBy("want_to_watch")}
              onClick={() => {
                if (ranked && !item.viewer_want_to_watch) {
                  failure.clear();
                  setConfirming("want_to_watch");
                } else void failure.run("want_to_watch", saveWantToWatch);
              }}
            >
              {item.viewer_want_to_watch
                ? "✓ Want to watch"
                : "+ Want to watch"}
            </ActionButton>
          )}
          <ActionButton
            ref={recommendButton}
            className="text-button"
            disabled={!interactive}
            unavailable={busy}
            aria-describedby={failure.describedBy("recommended")}
            onClick={() => {
              if (ranked) {
                failure.clear();
                setConfirming("recommended");
              } else
                void failure.run("recommended", () =>
                  activity(title.id, "recommended", !item.viewer_recommended),
                );
            }}
          >
            {item.viewer_recommended ? "✓ Recommended" : "+ Recommend"}
          </ActionButton>
        </>
      )}
      {!compact && copyLink}
    </div>
  );
  const byline = item && (
    <p className="activity-by" id={`by-${item.id}`}>
      <Avatar
        person={{
          user_id: item.owner_id,
          display_name: item.display_name,
          photo: item.photo,
        }}
      />
      <Link href={`/people/${item.username}`} prefetch={false}>
        {item.display_name}
      </Link>{" "}
      <span className="muted">
        {item.item_type === "comment"
          ? compact
            ? "commented"
            : "commented on"
          : item.item_type === "post"
            ? "posted"
            : item.item_type === "earlier"
              ? "· Earlier discussion"
              : item.item_type === "review"
                ? reviewPhrase(item)
                : item.item_type === "progress"
                  ? progressPhrase(
                      item.status!,
                      item.finished_on,
                      item.active,
                      interactive,
                    )
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
        <ActivityTime value={item.visible_activity} interactive={interactive} />
        {item.edited && "\u00a0·\u00a0Edited"}
      </span>
    </p>
  );

  return (
    <article
      ref={entry}
      hidden={!item}
      className={`feed-entry${compact ? " compact" : ""}`}
      data-item-id={item?.id}
      id={item ? `item-${item.id}` : undefined}
      // The author line and title name an entry; compact entries and posts
      // without a title have no title heading. The friend line focuses an
      // entry after scrolling to it, and removals can move focus to it.
      aria-labelledby={
        item
          ? compact || !title
            ? `by-${item.id}`
            : `by-${item.id} title-${item.id}`
          : undefined
      }
      tabIndex={-1}
    >
      {item && (
        <header className="activity-card" data-item-heading={item.id}>
          <div className="activity-summary">
            {!compact && title && (
              <Link
                className="poster-link"
                href={titleURL}
                prefetch={false}
                aria-label={title.name}
              >
                <Poster path={item.poster_path} name={title.name} />
              </Link>
            )}
            <div className="activity-content">
              {compact ? (
                <div className="compact-byline">
                  {byline}
                  {copyLink}
                </div>
              ) : (
                <>
                  {byline}
                  {title && (
                    <>
                      <h2 id={`title-${item.id}`}>
                        <Link href={titleURL} prefetch={false}>
                          {title.name}
                        </Link>
                      </h2>
                      <p className="small muted">{titleDetails(title)}</p>
                    </>
                  )}
                </>
              )}
              {/* The label stays outside the spoiler cover. */}
              {item.season !== null && (
                <p className="discussion-label">
                  {discussionLabel(item.season, item.episode)}
                </p>
              )}
              {deletable && !item.active && (
                <p className="muted" id={`removed-${item.id}`} tabIndex={-1}>
                  {item.item_type === "post"
                    ? "Post removed"
                    : "Comment removed"}
                </p>
              )}
              {/* A spoiler flag covers the text, not the rating. */}
              {item.rating != null && <ReviewStars rating={item.rating} />}
              {hiddenSpoiler ? (
                <button className="spoiler" onClick={() => setRevealed(true)}>
                  Contains spoilers · Reveal discussion
                </button>
              ) : (
                item.body && <p className="comment-body">{item.body}</p>
              )}
            </div>
          </div>
          {!hiddenSpoiler && !erased ? (
            <Reactions
              item={item.id}
              summary={item.reactions}
              refresh={refresh}
            >
              {titleActions}
            </Reactions>
          ) : (
            titleActions && <div className="item-actions">{titleActions}</div>
          )}
          {failure.alert}
          {canDelete && confirming === "delete" && (
            <ConfirmAction
              message={`Delete this ${item.item_type === "post" ? "post" : "comment"}? Its text will be erased.`}
              action="Delete"
              run={async () => {
                // An entry with replies keeps its placeholder; otherwise it
                // leaves the feed.
                removal.start(deleteButton.current, [
                  `removed-${item.id}`,
                  ...entryFocus(),
                ]);
                await api("remove-comment", { id: item.id });
                await refresh();
              }}
              onDone={() => {
                setConfirming(null);
                removal.done();
              }}
              onCancel={() => {
                setConfirming(null);
                deleteButton.current?.focus();
              }}
            />
          )}
          {/* Closes on its own once the title leaves the reader's top 10
              elsewhere. Either way, focus returns to the action. */}
          {(confirming === "recommended" || confirming === "want_to_watch") &&
            ranked &&
            title && (
              <ConfirmAction
                key={confirming}
                {...leavingTopTen(
                  confirming === "recommended" ? "withdraw" : "switch",
                  title.name,
                  item.viewer_top_ten_rank!,
                )}
                busy={busy}
                run={async () => {
                  if (confirming === "recommended")
                    await activity(title.id, "recommended", false);
                  else await saveWantToWatch();
                }}
                onDone={() => {
                  setConfirming(null);
                  (confirming === "recommended"
                    ? recommendButton
                    : wantButton
                  ).current?.focus();
                }}
                onCancel={() => {
                  setConfirming(null);
                  (confirming === "recommended"
                    ? recommendButton
                    : wantButton
                  ).current?.focus();
                }}
              />
            )}
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
        entryFocus={entryFocus}
      />
    </article>
  );
}
