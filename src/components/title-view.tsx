"use client";
import { useSearchParams } from "next/navigation";
import type { ScreenData } from "../server/screens";
import type { Person, SaveSurface } from "../shared";
import { useInteractive } from "./client";
import { Poster } from "./poster";
import { TitleAvailability } from "./title-availability";
import { TitleCommentComposer } from "./title-comment";
import { TitleTrailer } from "./title-trailer";
import { useActionError } from "./action-error";
// Suggestion tiles and Watch together open title pages with ?from=<surface>,
// so a Want to watch save here reports where the member found the title.
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
  refresh,
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
  refresh: () => Promise<void>;
}) {
  const interactive = useInteractive();
  const from = useSearchParams().get("from") as SaveSurface | null;
  const surface = from && origins.includes(from) ? from : "title";
  const failure = useActionError();
  const own = (data?.conversations ?? []).filter(
    (c) => c.owner_id === user.user_id,
  );
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
                <button
                  className="primary"
                  disabled={busy || !interactive}
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
                </button>
                <button
                  className="secondary"
                  disabled={busy || !interactive}
                  aria-describedby={failure.describedBy("want_to_watch")}
                  onClick={() =>
                    void failure.run("want_to_watch", () =>
                      activity(
                        data.title.id,
                        "want_to_watch",
                        !own.some((c) => c.want_to_watch),
                        surface,
                      ),
                    )
                  }
                >
                  {own.some((c) => c.want_to_watch)
                    ? "✓ Want to watch"
                    : "+ Want to watch"}
                </button>
              </div>
              {failure.alert}
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
          <div className="section-heading">
            <h2>Around this title</h2>
            <span className="muted">Your circle’s conversations</span>
          </div>
        </>
      )}
      <TitleCommentComposer
        titleId={data?.title.id ?? null}
        refresh={refresh}
      />
    </>
  );
}
