import type { TitleRelease } from "../shared";

// A title's US release status, such as "In theaters · Digital Dec 9", as the
// server derived it for today (docs/title-availability.md#release-status-implementation).
// The text comes from the screen data, never the reader's clock, so server
// and hydration markup match. Nothing shows without a label, including when
// the release data could not be loaded.
export function ReleaseStatus({ release }: { release?: TitleRelease }) {
  if (release?.status !== "ok") return null;
  const labels = [
    ...(release.in_theaters ? ["In theaters"] : []),
    ...release.upcoming.map((date) => date.label),
  ];
  if (!labels.length) return null;
  return <p className="release-status">{labels.join(" · ")}</p>;
}
