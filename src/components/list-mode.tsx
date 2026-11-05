"use client";
import { Link } from "./pending-navigation";
import type { ReleaseTitle } from "../shared";
import {
  memberPath,
  type MemberRoute,
  type TitleOrigin,
} from "../member-routes";
import { TitleCard } from "./title-card";

export type ListRoute = Extract<
  MemberRoute,
  { kind: "want-to-watch" | "watch-together" }
>;

// The At home and In theaters switch on Want to watch pages and Watch
// together (docs/want-to-watch.md#in-theaters), between the page heading and
// the list. Each mode has its own URL, so a reload keeps it, and choosing one
// reads that mode's list from the server.
export function ListModeSwitch({ route }: { route: ListRoute }) {
  return (
    <nav className="view-tabs">
      {(
        [
          [undefined, "At home"],
          ["theaters", "In theaters"],
        ] as const
      ).map(([mode, label]) => (
        <Link
          key={label}
          href={memberPath({ ...route, mode })}
          prefetch={false}
          aria-current={route.mode === mode ? "page" : undefined}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

// An In theaters list: the movies in US theaters now, in the server's order,
// then the movies whose release data could not be loaded. Cards show each
// movie's release status and no viewing options. `empty` shows when no movie
// is in theaters.
export function InTheatersList({
  titles,
  noun,
  empty,
  from,
}: {
  titles: ReleaseTitle[];
  // What the count names, such as "movie" or "shared movie".
  noun: string;
  empty: { heading: string; message: string; findTitle?: boolean };
  from?: TitleOrigin;
}) {
  const showing = titles.filter((title) => title.release.in_theaters);
  const unknown = titles.filter(
    (title) => title.release.status === "unavailable",
  );
  const cards = (list: ReleaseTitle[]) => (
    <div className="search-results">
      {list.map((title) => (
        <TitleCard key={title.id} title={title} heading="h3" from={from} />
      ))}
    </div>
  );
  return (
    <>
      <p className="small muted watch-together-count">
        {showing.length} {noun}
        {showing.length === 1 ? "" : "s"} in theaters
      </p>
      {showing.length > 0 ? (
        <section className="watch-section">
          <h2>In theaters now</h2>
          <p className="small muted">
            Based on US release dates. Check local theaters for showtimes.
          </p>
          {cards(showing)}
        </section>
      ) : (
        <div className="empty-card">
          <h2>{empty.heading}</h2>
          <p>{empty.message}</p>
          {empty.findTitle && (
            <Link href="/search" prefetch={false}>
              Find a title
            </Link>
          )}
        </div>
      )}
      {unknown.length > 0 && (
        <section className="watch-section">
          <h2>Availability unknown</h2>
          <p className="small muted">
            We could not load release dates for these movies.
          </p>
          {cards(unknown)}
        </section>
      )}
    </>
  );
}
