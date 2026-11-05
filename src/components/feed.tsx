"use client";
import { Link } from "./pending-navigation";
import { useEffect, useRef, useState } from "react";
import type { FeedItem, Person, SaveSurface } from "../shared";
import { api, useInteractive } from "./client";
import { Poster } from "./poster";
import { live, removable, ThreadView } from "./thread";
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
  targetUnavailable,
  available,
  showEmpty,
  compact,
  shownEntry,
  older,
  showOlder,
  olderThan,
}: {
  // Null while a failed read clears the screen, when `available` is false,
  // or while the screen offers no feed.
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
  targetUnavailable: boolean;
  available: boolean;
  showEmpty: boolean;
  compact: boolean;
  shownEntry: { item: string } | null;
  // Whether the history has entries older than the snapshot's, which Show
  // older reads (docs/title-feed.md#paged-histories).
  older: boolean;
  showOlder: () => Promise<void>;
  // Entries this old or older came through Show older, not as new activity,
  // so they show at once. Every entry newer than the window's start was
  // already in it.
  olderThan: string | null;
}) {
  const [known, setKnown] = useState<Known | null>(() =>
    snapshot ? capture(snapshot) : null,
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const interactive = useInteractive();
  // Keep only identities when access is unavailable. The current authorized
  // snapshot is always the source of rendered server content.
  const [slots, setSlots] = useState(() => snapshot?.map((c) => c.id) ?? []);
  const accepted = known ?? capture(snapshot ?? []);
  if (!known && snapshot) setKnown(accepted);
  const loaded =
    olderThan && snapshot
      ? snapshot.filter(
          (c) =>
            !accepted.has(c.id) &&
            Date.parse(c.visible_activity) <= Date.parse(olderThan),
        )
      : [];
  if (loaded.length) setKnown(new Map([...accepted, ...capture(loaded)]));
  // Large feeds hold thousands of entries, so lookups use sets and maps
  // built once per render instead of scanning the list for each entry.
  const slotted = new Set(slots);
  const newSlots =
    snapshot?.filter((c) => !slotted.has(c.id)).map((c) => c.id) ?? [];
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
  const visibleById = new Map(visible.map((c) => [c.id, c]));
  const order = [
    ...visible.map((c) => c.id),
    ...slots.filter((id) => !visibleById.has(id)),
  ];
  // A friend line name can name an entry still waiting behind New activity.
  // Showing it accepts the pending activity, as New activity would.
  const [handledEntry, setHandledEntry] = useState(shownEntry);
  if (shownEntry !== handledEntry) {
    setHandledEntry(shownEntry);
    if (
      snapshot &&
      shownEntry &&
      !visibleById.has(shownEntry.item) &&
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
      {targetUnavailable && <p>This activity is unavailable.</p>}
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
            item={visibleById.get(id) ?? null}
            available={available}
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
      {snapshot && older && (
        <ActionButton
          className="secondary feed-older"
          disabled={!interactive}
          unavailable={loadingOlder}
          onClick={() => {
            setLoadingOlder(true);
            void showOlder().finally(() => setLoadingOlder(false));
          }}
        >
          Show older
        </ActionButton>
      )}
    </section>
  );
}

function FeedEntry({
  item,
  available,
  user,
  refresh,
  activity,
  busy,
  target,
  compact,
  shown,
}: {
  item: FeedItem | null;
  available: boolean;
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
  // Delete waits for its confirmation beneath the entry's action line, and so
  // does a title action that would take the title out of the reader's top 10.
  // A comment's Delete or Remove waits beneath the comment.
  const [confirming, setConfirming] = useState<
    "delete" | "recommended" | "want_to_watch" | null
  >(null);
  const [confirmingComment, setConfirmingComment] = useState<string | null>(
    null,
  );
  // A failed read hides the entry. While a confirmation is open, the entry
  // keeps the item from the last read, so the confirmation stays, alone,
  // with its action waiting for the next read.
  const [lastItem, setLastItem] = useState(item);
  if (available && item !== lastItem && (confirming || confirmingComment))
    setLastItem(item);
  const held = available ? item : lastItem;
  const hiddenSpoiler = !!held?.spoiler && !revealed;
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
  // it so keyboard users continue from there.
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
  const deleteButton = useRef<HTMLButtonElement>(null);
  const wantButton = useRef<HTMLButtonElement>(null);
  const recommendButton = useRef<HTMLButtonElement>(null);
  const ranked = !!held?.viewer_recommended && !!held.viewer_top_ten_rank;
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
    held?.title_id && held.title_name !== null && held.kind
      ? {
          id: held.title_id,
          name: held.title_name,
          kind: held.kind,
          release_date: held.release_date ?? "",
        }
      : null;
  const titleURL = title ? memberPath({ kind: "title", id: title.id }) : "";
  // Comments and posts can be deleted, keeping their replies.
  const deletable = held?.item_type === "comment" || held?.item_type === "post";

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
      <span className="copy-status small">{copyMessage}</span>
    </span>
  );
  // Deleted standalone comments and posts and removed reviews show no
  // reactions.
  const erased =
    (deletable || held?.item_type === "review") && !!held && !held.active;
  const canDelete =
    deletable && !!held?.active && held.owner_id === user.user_id;
  // A confirmation closes for good once its action no longer applies, such
  // as after the title leaves the top 10 elsewhere, so it never reopens
  // unasked.
  const confirmable =
    confirming === "delete"
      ? canDelete
      : confirming !== null && ranked && !!title;
  if (confirming && !confirmable) setConfirming(null);
  // The same holds for a comment's confirmation once the comment is gone.
  const thread = held && !hiddenSpoiler ? held : null;
  const commentConfirmable =
    !!confirmingComment &&
    !!thread &&
    thread.comments.some(
      (comment) =>
        comment.id === confirmingComment &&
        live(comment) &&
        removable(comment, thread, user),
    );
  if (confirmingComment && !commentConfirmable) setConfirmingComment(null);
  // Saving to Want to watch, or removing it, from a friend's entry.
  const saveWantToWatch = async () => {
    if (held && title)
      await activity(
        title.id,
        "want_to_watch",
        !held.viewer_want_to_watch,
        held.item_type === "recommended" && held.active
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
              onClick={() => {
                if (ranked && !item.viewer_want_to_watch) {
                  failure.clear();
                  setConfirming("want_to_watch");
                } else void failure.run(saveWantToWatch);
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
            onClick={() => {
              if (ranked) {
                failure.clear();
                setConfirming("recommended");
              } else
                void failure.run(() =>
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
      // While a failed read hides the entry, an open confirmation still shows.
      hidden={!item && !confirmable && !commentConfirmable}
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
      {held && (item || confirmable) && (
        <header className="activity-card" data-item-heading={held.id}>
          {item && (
            <>
              <div className="activity-summary">
                {!compact && title && (
                  <Link
                    className="poster-link"
                    href={titleURL}
                    prefetch={false}
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
                    <p
                      className="muted"
                      id={`removed-${item.id}`}
                      tabIndex={-1}
                    >
                      {item.item_type === "post"
                        ? "Post removed"
                        : "Comment removed"}
                    </p>
                  )}
                  {/* A spoiler flag covers the text, not the rating. */}
                  {item.rating != null && <ReviewStars rating={item.rating} />}
                  {hiddenSpoiler ? (
                    <button
                      className="spoiler"
                      onClick={() => setRevealed(true)}
                    >
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
                titleActions && (
                  <div className="item-actions">{titleActions}</div>
                )
              )}
              {failure.alert}
            </>
          )}
          {canDelete && confirming === "delete" && (
            <ConfirmAction
              message={`Delete this ${held.item_type === "post" ? "post" : "comment"}? Its text will be erased.`}
              action="Delete"
              unavailable={!available}
              run={async () => {
                // An entry with replies keeps its placeholder; otherwise it
                // leaves the feed.
                removal.start(deleteButton.current, [
                  `removed-${held.id}`,
                  ...entryFocus(),
                ]);
                await api("remove-comment", { id: held.id });
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
                  held.viewer_top_ten_rank!,
                )}
                busy={busy}
                unavailable={!available}
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
        snapshot={thread && { conversation: thread, comments: thread.comments }}
        available={available}
        confirming={confirmingComment}
        setConfirming={setConfirmingComment}
        user={user}
        refresh={refresh}
        targetReply={target?.reply}
        entryFocus={entryFocus}
      />
    </article>
  );
}
