"use client";
import { useSearchParams } from "next/navigation";
import type { ScreenData } from "../server/screens";
import type { Person, SaveSurface, WatchStatus } from "../shared";
import { useInteractive } from "./client";
import { Poster } from "./poster";
import { TitleAvailability } from "./title-availability";
import { TitleCommentComposer } from "./title-comment";
import { TitleFriends } from "./title-friends";
import { TitleTrailer } from "./title-trailer";
import { useActionError } from "./action-error";
import { ActionButton } from "./action-button";
import { localToday, WatchStatusMenu } from "./watch-status";
import { useReviewEditor } from "./review";
// Suggestion tiles and Watch together open title pages with ?from=<surface>,
// so a Want to watch status chosen here reports where the member found the
// title.
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
                  className="primary"
                  disabled={!interactive}
                  unavailable={busy}
                  aria-describedby={failure.describedBy("recommended")}
                  onClick={() =>
                    void failure.run("recommended", () =>
                      activity(
                        data.title.id,
                        "recommended",
                        !own.some((c) => c.recommended),
                      ),
                    )
                  }
                >
                  {own.some((c) => c.recommended)
                    ? "✓ Recommended"
                    : "Recommend to friends"}
                </ActionButton>
                <WatchStatusMenu
                  kind={data.title.kind}
                  status={data.watch.status}
                  finishedOn={data.watch.finished_on}
                  disabled={!interactive}
                  unavailable={busy}
                  describedBy={failure.describedBy("status")}
                  onStatus={(status) =>
                    void failure.run("status", () =>
                      watchStatus(
                        data.title.id,
                        status,
                        status === "finished" ? localToday() : undefined,
                        status === "want_to_watch" ? surface : undefined,
                      ),
                    )
                  }
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
      <TitleCommentComposer
        titleId={data?.title.id ?? null}
        refresh={refresh}
      />
    </>
  );
}
