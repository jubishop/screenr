"use client";
import { useRef, useState, type RefObject } from "react";
import type { ScreenData } from "../server/screens";
import type { TitleOrigin } from "../member-routes";
import type { Person, SaveSurface, WatchStatus } from "../shared";
import { topTenLimit } from "../shared";
import { useInteractive } from "./client";
import { Poster } from "./poster";
import { TitleAvailability } from "./title-availability";
import { StartConversation } from "./start-conversation";
import { TitleFriends } from "./title-friends";
import { TitleTrailer } from "./title-trailer";
import { useActionError } from "./action-error";
import { ActionButton } from "./action-button";
import { localToday, WatchStatusMenu } from "./watch-status";
import { reviewDraft, useReviewEditor } from "./review";
import { ConfirmAction } from "./confirmation";
import { leavingTopTen, TopTenReplace, type ChangeTopTen } from "./top-ten";

// Suggestion tiles, Friends recommend, and Watch together open title pages
// with the route's `from`, so a Want to watch status chosen here reports
// where the member found the title.
export function TitleView({
  data,
  from,
  user,
  busy,
  activity,
  watchStatus,
  finishedDate,
  topTen,
  refresh,
  showEntry,
}: {
  data: Extract<ScreenData, { kind: "title" }> | null;
  from?: TitleOrigin;
  user: Person;
  busy: boolean;
  activity: (
    title: string,
    field: string,
    value: boolean,
    surface?: SaveSurface,
  ) => Promise<unknown>;
  watchStatus: (
    title: string,
    status: WatchStatus | null,
    finishedOn?: string,
    surface?: SaveSurface,
  ) => Promise<unknown>;
  finishedDate: (title: string, date: string | null) => Promise<unknown>;
  topTen: ChangeTopTen;
  refresh: () => Promise<void>;
  showEntry: (item: string) => void;
}) {
  const interactive = useInteractive();
  const surface: SaveSurface = from ?? "title";
  const failure = useActionError();
  // A failed read clears `data` and hides the title. Its prompts and the
  // review's Remove confirmation keep the last title, so an open one stays,
  // alone, with its action waiting for the next read.
  const [last, setLast] = useState(data);
  if (data && data !== last) setLast(data);
  const shown = data ?? last;
  const own = (shown?.conversations ?? []).filter(
    (c) => c.owner_id === user.user_id,
  );
  // The viewer's review, which may be inside a card another entry holds.
  const ownReview = own
    .flatMap((c) => (c.active ? [c, ...c.combined] : []))
    .find((c) => c.item_type === "review");
  const review = useReviewEditor({
    titleId: shown?.title.id ?? null,
    saved: ownReview ? reviewDraft(ownReview) : null,
    available: !!data,
    refresh,
  });
  const recommended = own.some((c) => c.recommended);
  // The viewer's own top 10 and this title's rank in it.
  const entries = shown?.topTen ?? [];
  const rank = entries.find((entry) => entry.id === shown?.title.id)?.rank;
  // One in-page prompt at a time beneath the header buttons: confirming that
  // withdrawing Recommend, or switching to Want to watch, also leaves the top
  // 10, or choosing an entry to remove from a full list. A prompt closes for
  // good once its title no longer needs it, such as after a change in
  // another tab, so it never reopens unasked.
  const [prompt, setPrompt] = useState<"withdraw" | "switch" | "replace">();
  const open =
    prompt === "replace"
      ? rank
        ? undefined
        : prompt
      : prompt && rank && recommended
        ? prompt
        : undefined;
  if (prompt && !open) setPrompt(undefined);
  const recommendButton = useRef<HTMLButtonElement>(null);
  const statusButton = useRef<HTMLButtonElement>(null);
  const topTenButton = useRef<HTMLButtonElement>(null);
  function ask(next: NonNullable<typeof prompt>) {
    failure.clear();
    setPrompt(next);
  }
  // Closing a prompt returns focus to the control that opened it.
  function close(control: RefObject<HTMLButtonElement | null>) {
    setPrompt(undefined);
    control.current?.focus();
  }
  return (
    <>
      {shown && (
        <>
          <div className="title-hero">
            {data && (
              <Poster
                path={data.title.poster_path}
                name={data.title.name}
                large
              />
            )}
            <div>
              {data && (
                <>
                  <p className="eyebrow">
                    {data.title.kind === "movie" ? "MOVIE" : "TV SHOW"} ·{" "}
                    {data.title.release_date.slice(0, 4) || "DATE UNAVAILABLE"}
                  </p>
                  <h1>{data.title.name}</h1>
                  <p className="overview">
                    {data.title.overview || "No synopsis available."}
                  </p>
                  <div className="inline-actions">
                    <ActionButton
                      ref={recommendButton}
                      className="primary"
                      disabled={!interactive}
                      unavailable={busy}
                      onClick={() => {
                        if (recommended && rank) ask("withdraw");
                        else
                          void failure.run(() =>
                            activity(
                              data.title.id,
                              "recommended",
                              !recommended,
                            ),
                          );
                      }}
                    >
                      {recommended ? "✓ Recommended" : "Recommend to friends"}
                    </ActionButton>
                    {/* Adding recommends the title; the listed state removes it
                    from the top 10 and keeps the Recommend. */}
                    <ActionButton
                      ref={topTenButton}
                      className="secondary"
                      disabled={!interactive}
                      unavailable={busy}
                      onClick={() => {
                        if (rank)
                          void failure.run(() =>
                            topTen(data.title.id, "remove"),
                          );
                        else if (entries.length >= topTenLimit) ask("replace");
                        else
                          void failure.run(() => topTen(data.title.id, "add"));
                      }}
                    >
                      {rank ? `✓ #${rank} in your top 10` : "Add to top 10"}
                    </ActionButton>
                    <WatchStatusMenu
                      kind={data.title.kind}
                      status={data.watch.status}
                      finishedOn={data.watch.finished_on}
                      disabled={!interactive}
                      unavailable={busy}
                      buttonRef={statusButton}
                      onStatus={(status) => {
                        if (status === "want_to_watch" && recommended && rank)
                          ask("switch");
                        else
                          void failure.run(() =>
                            watchStatus(
                              data.title.id,
                              status,
                              status === "finished" ? localToday() : undefined,
                              status === "want_to_watch" ? surface : undefined,
                            ),
                          );
                      }}
                      onDate={(date) =>
                        void failure.run(() =>
                          finishedDate(data.title.id, date),
                        )
                      }
                    />
                    {review.button}
                  </div>
                  {failure.alert}
                </>
              )}
              {review.panel}
              {(open === "withdraw" || open === "switch") && rank && (
                <ConfirmAction
                  key={open}
                  {...leavingTopTen(open, shown.title.name, rank)}
                  busy={busy}
                  unavailable={!data}
                  run={() =>
                    open === "withdraw"
                      ? activity(shown.title.id, "recommended", false)
                      : watchStatus(
                          shown.title.id,
                          "want_to_watch",
                          undefined,
                          surface,
                        )
                  }
                  onDone={() =>
                    close(open === "withdraw" ? recommendButton : statusButton)
                  }
                  onCancel={() =>
                    close(open === "withdraw" ? recommendButton : statusButton)
                  }
                />
              )}
              {open === "replace" && (
                <TopTenReplace
                  name={shown.title.name}
                  entries={entries}
                  busy={busy}
                  unavailable={!data}
                  run={(replace) => topTen(shown.title.id, "add", { replace })}
                  onDone={() => close(topTenButton)}
                  onCancel={() => close(topTenButton)}
                />
              )}
              {data && (
                <TitleFriends friends={data.friends} showEntry={showEntry} />
              )}
            </div>
          </div>
          {data && (
            <TitleAvailability
              availability={data.availability}
              release={data.release}
              score={data.tmdb_score}
              kind={data.title.kind}
            />
          )}
          {data?.trailer && (
            <TitleTrailer
              key={`${data.title.id}/${data.trailer.key}`}
              name={data.title.name}
              trailer={data.trailer}
            />
          )}
        </>
      )}
      <StartConversation
        title={data && { id: data.title.id, kind: data.title.kind }}
        available={!!data}
        refresh={refresh}
      />
    </>
  );
}
