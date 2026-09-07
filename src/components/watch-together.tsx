"use client";
import Link from "next/link";
import { useState } from "react";
import type { Person, Title } from "../shared";
import { Poster } from "./poster";

export function WatchTogether({
  participants,
  titles,
}: {
  participants: Person[];
  titles: Title[];
}) {
  const [filter, setFilter] = useState<"all" | Title["kind"]>("all");
  const visible = titles.filter(
    (title) => filter === "all" || title.kind === filter,
  );
  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">GOOD COMPANY. SHARED PICKS.</p>
        <h1>Watch together</h1>
        <p>
          {participants.map((person, index) => (
            <span key={person.user_id}>
              {index > 0 && " & "}
              <Link href={`/people/${person.username}`} prefetch={false}>
                {person.display_name}
              </Link>
            </span>
          ))}
        </p>
        <p>Everything you both want to watch. Newest shared matches first.</p>
      </div>
      <div className="inline-actions" role="group" aria-label="Title type">
        {(
          [
            ["all", "All"],
            ["movie", "Movies"],
            ["tv", "TV"],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            className={filter === value ? "primary" : "secondary"}
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="small muted watch-together-count" role="status">
        {visible.length} shared {visible.length === 1 ? "title" : "titles"}
      </p>
      <section className="search-results" aria-label="Shared titles">
        {visible.map((title) => (
          <Link
            className="search-result"
            key={title.id}
            href={`/titles/${title.id.replace(":", "/")}`}
            prefetch={false}
          >
            <Poster path={title.poster_path} name={title.name} />
            <div>
              <h2>{title.name}</h2>
              <p className="muted">
                {title.kind === "movie" ? "Movie" : "TV show"}
                {title.release_date && ` · ${title.release_date.slice(0, 4)}`}
              </p>
              <p className="small overview">{title.overview.slice(0, 150)}</p>
            </div>
            <span aria-hidden="true">↗</span>
          </Link>
        ))}
      </section>
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
