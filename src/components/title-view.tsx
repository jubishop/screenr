"use client";
import { useSearchParams } from "next/navigation";
import { useRef, useState, type RefObject } from "react";
import type { ScreenData } from "../server/screens";
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
import { useReviewEditor } from "./review";
import { ConfirmAction } from "./confirmation";
import { leavingTopTen, TopTenReplace, type ChangeTopTen } from "./top-ten";
// Suggestion tiles, Friends recommend, and Watch together open title pages
// with ?from=<surface>, so a Want to watch status chosen here reports where
// the member found the title.
const origins: SaveSurface[] = [
  "friends_recommend",
  "suggestion_recommendation",
  "suggestion",
  "watch_together",
];

export function TitleView({
  data,
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
  const from = useSearchParams().get("from") as SaveSurface | null;
  const surface = from && origins.includes(from) ? from : "title";
  const failure = useActionError();
  const own = (data?.conversations ?? []).filter(
    (c) => c.owner_id === user.user_id,
  );
  const ownReview = own.find((c) => c.item_type === "review" && c.active);
  const review = useReviewEditor({
    titleId: data?.title.id ?? null,
    saved: ownReview
      ? {
          rating: ownReview.rating,
          body: ownReview.body ?? "",
          spoiler: ownReview.spoiler,
        }
      : null,
    refresh,
  });
  const recommended = own.some((c) => c.recommended);
  // The viewer's own top 10 and this title's rank in it.
  const entries = data?.topTen ?? [];
  const rank = entries.find((entry) => entry.id === data?.title.id)?.rank;
  // One in-page prompt at a time beneath the header buttons: confirming that
  // withdrawing Recommend, or switching to Want to watch, also leaves the top
  // 10, or choosing an entry to remove from a full list. A prompt closes on
  // its own once its title no longer needs it, such as after a change in
  // another tab.
  const [prompt, setPrompt] = useState<"withdraw" | "switch" | "replace">();
  const open =
    prompt === "replace"
      ? rank
        ? undefined
        : prompt
      : prompt && rank && recommended
        ? prompt
        : undefined;
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
      {data && (
        <>
          <div className="title-hero">
            <Poster
              path={data.title.poster_path}
              name={data.title.name}
              large
            />
            <div>
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
                  aria-describedby={failure.describedBy("recommended")}
                  onClick={() => {
                    if (recommended && rank) ask("withdraw");
                    else
                      void failure.run("recommended", () =>
                        activity(data.title.id, "recommended", !recommended),
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
                  aria-describedby={failure.describedBy("top-ten")}
                  onClick={() => {
                    if (rank)
                      void failure.run("top-ten", () =>
                        topTen(data.title.id, "remove"),
                      );
                    else if (entries.length >= topTenLimit) ask("replace");
                    else
                      void failure.run("top-ten", () =>
                        topTen(data.title.id, "add"),
                      );
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
                  describedBy={failure.describedBy("status")}
                  buttonRef={statusButton}
                  onStatus={(status) => {
                    if (status === "want_to_watch" && recommended && rank)
                      ask("switch");
                    else
                      void failure.run("status", () =>
                        watchStatus(
                          data.title.id,
                          status,
                          status === "finished" ? localToday() : undefined,
                          status === "want_to_watch" ? surface : undefined,
                        ),
                      );
                  }}
                  onDate={(date) =>
                    void failure.run("status", () =>
                      finishedDate(data.title.id, date),
                    )
                  }
                />
                {review.button}
              </div>
              {failure.alert}
              {review.panel}
              {(open === "withdraw" || open === "switch") && rank && (
                <ConfirmAction
                  key={open}
                  {...leavingTopTen(open, data.title.name, rank)}
                  busy={busy}
                  run={() =>
                    open === "withdraw"
                      ? activity(data.title.id, "recommended", false)
                      : watchStatus(
                          data.title.id,
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
                  name={data.title.name}
                  entries={entries}
                  busy={busy}
                  run={(replace) => topTen(data.title.id, "add", { replace })}
                  onDone={() => close(topTenButton)}
                  onCancel={() => close(topTenButton)}
                />
              )}
              <TitleFriends friends={data.friends} showEntry={showEntry} />
            </div>
          </div>
          <TitleAvailability
            availability={data.availability}
            kind={data.title.kind}
          />
          {data.trailer && (
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
