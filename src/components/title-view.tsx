"use client";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { useInteractive } from "./client";
import { Poster } from "./poster";
import { TitleAvailability } from "./title-availability";
import { TitleCommentComposer } from "./title-comment";
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
  activity: (title: string, field: string, value: boolean) => Promise<unknown>;
  refresh: () => Promise<void>;
}) {
  const interactive = useInteractive();
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
                  onClick={() =>
                    void activity(
                      data.title.id,
                      "recommended",
                      !own.some((c) => c.recommended),
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
                  onClick={() =>
                    void activity(
                      data.title.id,
                      "want_to_watch",
                      !own.some((c) => c.want_to_watch),
                    )
                  }
                >
                  {own.some((c) => c.want_to_watch)
                    ? "✓ Want to watch"
                    : "+ Want to watch"}
                </button>
              </div>
            </div>
          </div>
          <TitleAvailability
            availability={data.availability}
            kind={data.title.kind}
          />
          {data.trailer && (
            <section
              className="title-trailer"
              aria-labelledby="trailer-heading"
            >
              <div className="section-heading">
                <h2 id="trailer-heading">Trailer</h2>
                <a
                  href={`https://www.youtube.com/watch?v=${data.trailer.key}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Watch on YouTube
                </a>
              </div>
              <iframe
                className="trailer-player"
                src={`https://www.youtube.com/embed/${data.trailer.key}?autoplay=0&playsinline=1`}
                title={`${data.title.name} trailer: ${data.trailer.name}`}
                referrerPolicy="strict-origin-when-cross-origin"
                allow="encrypted-media; fullscreen; picture-in-picture"
                allowFullScreen
              />
              <p className="small muted">
                If the trailer cannot play here, watch it on YouTube.
              </p>
            </section>
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
