"use client";
import { useRef, useState, type RefObject } from "react";
import type { FeedItem, SaveSurface, WatchStatus } from "../shared";
import { useInteractive } from "./client";
import { ActionButton } from "./action-button";
import { useActionError } from "./action-error";
import { ConfirmAction } from "./confirmation";
import { Icon } from "./icons";
import { useRemovalFocus, type FocusTarget } from "./removal-focus";
import { reviewDraft, useReviewEditor } from "./review";
import { leavingTopTen } from "./top-ten";
import { localToday, WatchStatusMenu } from "./watch-status";

export type TitleActivity = (
  title: string,
  field: string,
  value: boolean,
  surface?: SaveSurface,
) => Promise<unknown>;
export type ChangeWatchStatus = (
  title: string,
  status: WatchStatus | null,
  finishedOn?: string,
  surface?: SaveSurface,
) => Promise<unknown>;
export type ChangeFinishedDate = (
  title: string,
  date: string | null,
) => Promise<unknown>;

// A full feed entry's title actions, including on the reader's own entries
// (docs/interface-design.md#icon-actions-on-feed-entries--2026-11-09):
// Recommend, the title page's watch status menu, and Rate or review, as icon
// buttons that show the reader's own choices for the entry's title. They
// follow the title page's rules: withdrawing a top 10 title's Recommend, or
// switching it to Want to watch, asks first. `buttons` go on the entry's
// action line; `alert`, the actions' one failure message, and `prompts`, the
// review form and the top 10 confirmation, go beneath it. While a failed read
// hides the entry, `held` is the entry as last read, and `holding` says an
// open confirmation keeps it shown.
export function useEntryTitleActions({
  held,
  title,
  own,
  shown,
  available,
  busy,
  refresh,
  activity,
  watchStatus,
  finishedDate,
  entryFocus,
}: {
  held: FeedItem | null;
  title: { id: string; name: string; kind: "movie" | "tv" } | null;
  // Whether the entry is the reader's own, and whether it offers the
  // actions at all: compact title page entries leave them to the header.
  own: boolean;
  shown: boolean;
  available: boolean;
  busy: boolean;
  refresh: () => Promise<void>;
  activity: TitleActivity;
  watchStatus: ChangeWatchStatus;
  finishedDate: ChangeFinishedDate;
  // Where focus goes when an action takes the entry out of the feed.
  entryFocus: () => FocusTarget[];
}) {
  const interactive = useInteractive();
  const failure = useActionError();
  const removal = useRemovalFocus();
  const recommendButton = useRef<HTMLButtonElement>(null);
  const statusButton = useRef<HTMLButtonElement>(null);
  const offered = shown && title ? title : null;
  const review = useReviewEditor({
    titleId: offered?.id ?? null,
    saved: held?.viewer_review ? reviewDraft(held.viewer_review) : null,
    available,
    refresh,
    icon: true,
  });
  // The title's rank in the reader's top 10, which only a Recommend keeps.
  const rank = held?.viewer_recommended ? held.viewer_top_ten_rank : null;
  // A confirmation closes for good once its title leaves the top 10
  // elsewhere, so it never reopens unasked.
  const [prompt, setPrompt] = useState<"withdraw" | "switch" | null>(null);
  const open = prompt && rank && offered ? prompt : null;
  if (prompt && !open) setPrompt(null);
  // Want to watch from a friend's entry reports where it was saved; a card
  // with an active Recommend counts as one, whichever entry holds it. The
  // reader's own entry has no save surface.
  const surface: SaveSurface | undefined = own
    ? undefined
    : held?.recommended
      ? "friend_recommendation"
      : "friend_entry";
  const control = (which: "withdraw" | "switch") =>
    which === "withdraw" ? recommendButton : statusButton;

  // Saving can take the reader's own entry out of the feed, such as when
  // they withdraw its Recommend, and its controls with it. Focus then moves
  // to the nearest entry still shown.
  async function run(
    button: RefObject<HTMLButtonElement | null>,
    action: () => Promise<unknown>,
  ) {
    removal.start(button.current, entryFocus());
    await failure.run(action);
    removal.done();
  }
  function ask(next: "withdraw" | "switch") {
    failure.clear();
    setPrompt(next);
  }
  function close(which: "withdraw" | "switch") {
    setPrompt(null);
    control(which).current?.focus();
  }

  const recommended = !!held?.viewer_recommended;
  const buttons = offered && held && (
    <>
      <ActionButton
        ref={recommendButton}
        type="button"
        className={`icon-button${recommended ? " chosen" : ""}`}
        aria-label="Recommend"
        aria-pressed={recommended}
        title={recommended ? "Recommended" : "Recommend"}
        disabled={!interactive}
        unavailable={busy}
        onClick={() => {
          if (rank) ask("withdraw");
          else
            void run(recommendButton, () =>
              activity(offered.id, "recommended", !recommended),
            );
        }}
      >
        <Icon name="recommend" filled={recommended} />
      </ActionButton>
      <WatchStatusMenu
        icon
        kind={offered.kind}
        status={held.viewer_status}
        finishedOn={held.viewer_finished_on}
        disabled={!interactive}
        unavailable={busy}
        buttonRef={statusButton}
        onStatus={(status) => {
          if (status === "want_to_watch" && rank) ask("switch");
          else
            void run(statusButton, () =>
              watchStatus(
                offered.id,
                status,
                status === "finished" ? localToday() : undefined,
                status === "want_to_watch" ? surface : undefined,
              ),
            );
        }}
        onDate={(date) =>
          void run(statusButton, () => finishedDate(offered.id, date))
        }
      />
      {review.button}
    </>
  );
  const prompts = (
    <>
      {review.panel}
      {/* Either way, focus returns to the action. */}
      {open && rank && offered && (
        <ConfirmAction
          key={open}
          {...leavingTopTen(open, offered.name, rank)}
          busy={busy}
          unavailable={!available}
          run={async () => {
            removal.start(control(open).current, entryFocus());
            await (open === "withdraw"
              ? activity(offered.id, "recommended", false)
              : watchStatus(offered.id, "want_to_watch", undefined, surface));
          }}
          onDone={() => {
            close(open);
            removal.done();
          }}
          onCancel={() => close(open)}
        />
      )}
    </>
  );
  return {
    buttons,
    alert: failure.alert,
    prompts,
    holding: !!open || review.holding,
  };
}
