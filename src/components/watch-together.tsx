"use client";
import { Link } from "./pending-navigation";
import { useState } from "react";
import type { Person } from "../shared";
import type { ScreenData } from "../server/screens";
import { TitleCard } from "./title-card";
import {
  ofKind,
  TitleKindButtons,
  type TitleKindFilter,
} from "./title-kind-filter";
import { ServicesPrompt, ViewingAttribution } from "./title-services";
import { Avatar } from "./avatar";

export function WatchTogether({
  participants,
  titles,
  viewerHasServices,
}: {
  participants: Person[];
  titles: Extract<ScreenData, { kind: "watch-together" }>["titles"];
  viewerHasServices: boolean;
}) {
  const [filter, setFilter] = useState<TitleKindFilter>("all");
  const visible = ofKind(titles, filter);
  return (
    <>
      <div className="page-heading">
        <h1 className="page-title">Watch together</h1>
        <p className="participants">
          {participants.map((person, index) => (
            <span key={person.user_id}>
              {index > 0 && " & "}
              <span className="participant">
                <Avatar person={person} />
                <Link href={`/people/${person.username}`} prefetch={false}>
                  {person.display_name}
                </Link>
              </span>
            </span>
          ))}
        </p>
        <p>
          Everything you both want to watch. Your services and free options
          first, then your other shared picks.
        </p>
      </div>
      <TitleKindButtons value={filter} onChange={setFilter} />
      <p className="small muted watch-together-count" role="status">
        {visible.length} shared {visible.length === 1 ? "title" : "titles"}
      </p>
      {!viewerHasServices && <ServicesPrompt />}
      <section aria-label="Shared titles">
        {(
          [
            [
              "available",
              "Ready to watch",
              "On a service either of you has, or free. Newest shared matches first.",
            ],
            [
              "unmatched",
              "Not on your services",
              "No listed options match your saved services or offer free viewing.",
            ],
            [
              "unknown",
              "Availability unknown",
              "We could not confirm viewing options for these shared picks.",
            ],
          ] as const
        ).map(([access, heading, description]) => {
          const matches = visible.filter((title) => title.access === access);
          if (!matches.length) return null;
          return (
            <section
              className="watch-section"
              aria-label={heading}
              key={access}
            >
              <h2>{heading}</h2>
              <p className="small muted">{description}</p>
              <div className="search-results">
                {matches.map((title) => (
                  <TitleCard
                    key={title.id}
                    title={title}
                    heading="h3"
                    serviceIds={title.matchingServiceIds}
                    shared
                    from="watch_together"
                  />
                ))}
              </div>
            </section>
          );
        })}
      </section>
      {visible.length > 0 && <ViewingAttribution />}
      {visible.length === 0 && (
        <div className="empty-card">
          <h2>
            {titles.length === 0
              ? "No shared titles yet."
              : `No shared ${filter === "movie" ? "movies" : "TV shows"} yet.`}
          </h2>
          <p>
            {titles.length === 0
              ? "When you both add a title to Want to watch, it will appear here."
              : "Try All to see your other shared choices."}
          </p>
          {titles.length === 0 && (
            <Link href="/search" prefetch={false}>
              Find a title
            </Link>
          )}
        </div>
      )}
    </>
  );
}
