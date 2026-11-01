import type { TitleRelease, TmdbScore } from "../shared";

// A title's US release status, such as "In theaters · Digital Dec 9", as the
// server derived it for today (docs/title-availability.md#release-status-implementation),
// with TMDB's user score beside it: the TMDB logo and a whole percentage,
// such as 73% (docs/title-catalog.md#tmdb-user-score-implementation). The
// text comes from the screen data, never the reader's clock, so server and
// hydration markup match. Nothing shows without a release label or a score,
// including when the release data could not be loaded.
export function TitleStatus({
  release,
  score,
}: {
  release?: TitleRelease;
  score?: TmdbScore;
}) {
  const labels =
    release?.status === "ok"
      ? [
          ...(release.in_theaters ? ["In theaters"] : []),
          ...release.upcoming.map((date) => date.label),
        ]
      : [];
  const scored = typeof score === "number";
  if (!labels.length && !scored) return null;
  return (
    <div className="title-status">
      {labels.length > 0 && (
        <p className="release-status">{labels.join(" · ")}</p>
      )}
      {scored && (
        <p className="tmdb-score">
          <img src="/tmdb.svg" width="77" height="10" alt="TMDB" />
          {score}%
        </p>
      )}
    </div>
  );
}
