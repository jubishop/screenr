"use client";
import { Link } from "./pending-navigation";
import { useState } from "react";
import type { Person } from "../shared";
import type { ScreenData } from "../server/screens";
import { memberPath } from "../member-routes";
import { TitleCard } from "./title-card";
import {
  ofKind,
  TitleKindButtons,
  type TitleKindFilter,
} from "./title-kind-filter";
import { ServicesPrompt, ViewingAttribution } from "./title-services";
import { Avatar } from "./avatar";

type Page = Extract<ScreenData, { kind: "want-to-watch" }>;

// A profile's Want to watch page (docs/want-to-watch.md): the owner's titles
// the viewer can watch now, on the viewer's services or free, newest first,
// then those whose availability is unknown. Selecting a title opens its page,
// where the viewer changes their own choices.
export function WantToWatch({ data, user }: { data: Page; user: Person }) {
  const [filter, setFilter] = useState<TitleKindFilter>("all");
  const { owner, titles } = data;
  const own = owner.user_id === user.user_id;
  const shown = ofKind(titles, filter);
  const ready = shown.filter((title) => title.access === "available");
  const unknown = shown.filter((title) => title.access === "unknown");
  const kindName = filter === "movie" ? "movies" : "TV shows";
  const empty = !data.hasWantToWatch
    ? {
        heading: "No Want to watch titles yet.",
        message: own
          ? "When you add titles to Want to watch, the ones you can watch now appear here."
          : `When ${owner.display_name} adds titles to Want to watch, the ones you can watch now appear here.`,
      }
    : !titles.some((title) => title.access === "available")
      ? {
          heading: "Nothing to watch right now.",
          message: own
            ? "None of your Want to watch titles are on your services or free right now."
            : `None of ${owner.display_name}’s Want to watch titles are on your services or free right now.`,
        }
      : !ready.length
        ? {
            heading: `No ${kindName} to watch right now.`,
            message: "Try All to see the other titles you can watch.",
          }
        : null;
  return (
    <>
      <div className="page-heading">
        <h1 className="page-title">Want to watch</h1>
        <p className="participants">
          <span className="participant">
            <Avatar person={owner} />
            <Link
              href={memberPath({ kind: "profile", username: owner.username })}
              prefetch={false}
            >
              {owner.display_name}
            </Link>
          </span>
        </p>
        <p>
          {own
            ? "Titles you want to watch that are on your services or free, newest first."
            : `Titles ${owner.display_name} wants to watch that are on your services or free, newest first.`}
        </p>
      </div>
      {/* The At home and In theaters switch goes above the list (#311). */}
      <TitleKindButtons value={filter} onChange={setFilter} />
      <p className="small muted watch-together-count" role="status">
        {ready.length} {ready.length === 1 ? "title" : "titles"} to watch now
      </p>
      {!data.viewerHasServices && <ServicesPrompt />}
      <section aria-label="Want to watch titles">
        {ready.length > 0 && (
          <section className="watch-section" aria-label="Ready to watch">
            <h2>Ready to watch</h2>
            <p className="small muted">On your services or free.</p>
            <div className="search-results">
              {ready.map((title) => (
                <TitleCard
                  key={title.id}
                  title={title}
                  heading="h3"
                  serviceIds={title.matchingServiceIds}
                />
              ))}
            </div>
          </section>
        )}
        {empty && (
          <div className="empty-card">
            <h2>{empty.heading}</h2>
            <p>{empty.message}</p>
            {own && !data.hasWantToWatch && (
              <Link href="/search" prefetch={false}>
                Find a title
              </Link>
            )}
          </div>
        )}
        {unknown.length > 0 && (
          <section className="watch-section" aria-label="Availability unknown">
            <h2>Availability unknown</h2>
            <p className="small muted">
              We could not confirm viewing options for these titles.
            </p>
            <div className="search-results">
              {unknown.map((title) => (
                <TitleCard
                  key={title.id}
                  title={title}
                  heading="h3"
                  serviceIds={title.matchingServiceIds}
                />
              ))}
            </div>
          </section>
        )}
      </section>
      {shown.length > 0 && <ViewingAttribution />}
    </>
  );
}
