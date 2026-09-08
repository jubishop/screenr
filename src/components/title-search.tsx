"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Title, TitleSuggestion } from "../shared";
import { api, useInteractive } from "./client";
import { Poster } from "./poster";

function Reason({
  people,
  secondDegree,
  recommended,
}: {
  people: TitleSuggestion["recommended_by"];
  secondDegree: number;
  recommended: boolean;
}) {
  const action = (singular: boolean) =>
    recommended
      ? singular
        ? "recommends this"
        : "recommend this"
      : singular
        ? "wants to watch this"
        : "want to watch this";
  return (
    <>
      {people.length > 0 && (
        <p>
          {people.map((person) => person.display_name).join(", ")}{" "}
          {action(people.length === 1)}.
        </p>
      )}
      {secondDegree > 0 && (
        <p>
          {secondDegree}{" "}
          {secondDegree === 1 ? "friend of a friend" : "friends of friends"}
          {people.length > 0 ? " also " : " "}
          {action(secondDegree === 1)}.
        </p>
      )}
    </>
  );
}

export function TitleSearch({
  suggestions,
}: {
  suggestions: TitleSuggestion[] | null;
}) {
  const interactive = useInteractive();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Title[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
    },
    [],
  );

  function changeQuery(value: string) {
    setQuery(value);
    if (!value.trim()) {
      pending.current?.abort();
      pending.current = null;
      setResults(null);
      setSearching(false);
      setError("");
    }
  }

  async function search() {
    if (query.trim().length < 2) {
      setError("Enter at least two characters to search.");
      return;
    }
    pending.current?.abort();
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(10_000);
    pending.current = controller;
    setSearching(true);
    setResults([]);
    setError("");
    try {
      const titles = await api<Title[]>(
        `search?q=${encodeURIComponent(query.trim())}`,
        undefined,
        AbortSignal.any([controller.signal, timeout]),
      );
      if (pending.current === controller) setResults(titles);
    } catch (error) {
      if (pending.current === controller)
        setError(
          timeout.aborted
            ? "Search timed out. Please try again."
            : (error as Error).message,
        );
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setSearching(false);
      }
    }
  }

  return (
    <>
      <div className="page-heading">
        <p className="eyebrow">FIND SOMETHING GOOD</p>
        <h1>What’s on your mind?</h1>
        <p>Discover something through your circle, or search for a title.</p>
      </div>
      <form
        className="search-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label className="sr-only" htmlFor="title-search">
          Movie or show title
        </label>
        <input
          disabled={!interactive}
          id="title-search"
          placeholder="Search movies and TV shows"
          value={query}
          minLength={2}
          maxLength={120}
          required
          onChange={(event) => changeQuery(event.target.value)}
        />
        <button className="primary" disabled={!interactive}>
          {searching ? "Searching…" : "Search"}
        </button>
      </form>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {results !== null ? (
        <section
          className="search-results"
          aria-label="Search results"
          aria-busy={searching}
        >
          {results.map((title) => (
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
                  {title.kind === "movie" ? "Movie" : "TV show"} ·{" "}
                  {title.release_date.slice(0, 4)}
                </p>
                <p className="small overview">{title.overview.slice(0, 150)}</p>
              </div>
              <span aria-hidden="true">↗</span>
            </Link>
          ))}
          {!searching && !error && results.length === 0 && (
            <p className="empty">No matches. Try a different title.</p>
          )}
        </section>
      ) : suggestions !== null ? (
        suggestions.length ? (
          <>
            <div className="section-heading">
              <h2>From your circle</h2>
            </div>
            <section className="suggestion-grid" aria-label="Title suggestions">
              {suggestions.map((title) => (
                <Link
                  className="suggestion-tile"
                  key={title.id}
                  href={`/titles/${title.id.replace(":", "/")}`}
                  prefetch={false}
                >
                  <Poster
                    path={title.poster_path}
                    name={title.name}
                    sizes="(max-width: 560px) 45vw, 220px"
                  />
                  <h3>{title.name}</h3>
                  <div className="suggestion-reasons">
                    <Reason
                      people={title.recommended_by}
                      secondDegree={title.second_degree_recommended}
                      recommended
                    />
                    <Reason
                      people={title.wanted_by}
                      secondDegree={title.second_degree_wanted}
                      recommended={false}
                    />
                  </div>
                </Link>
              ))}
            </section>
          </>
        ) : (
          <div className="empty-card">
            <h2>No suggestions yet.</h2>
            <p>
              Search for a title above. New choices from your circle will appear
              here.
            </p>
          </div>
        )
      ) : null}
    </>
  );
}
