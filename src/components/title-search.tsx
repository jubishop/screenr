"use client";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { TitleSuggestion, ViewingTitle } from "../shared";
import { memberPath, parseMemberRoute } from "../member-routes";
import { viewingAccess } from "../viewing";
import { TitleServices, ViewingAttribution } from "./title-services";
import { api, useInteractive } from "./client";
import { Poster } from "./poster";
import { TitleCard } from "./title-card";

type ReasonAction = "recommended" | "want_to_watch" | "watching";

// "recommends this", "are also watching", and the like.
function phrase(action: ReasonAction, singular: boolean, also: boolean) {
  const extra = also ? "also " : "";
  if (action === "watching")
    return `${singular ? "is" : "are"} ${extra}watching`;
  return action === "recommended"
    ? `${extra}${singular ? "recommends" : "recommend"} this`
    : `${extra}${singular ? "wants" : "want"} to watch this`;
}

function Reason({
  people,
  secondDegree,
  action,
}: {
  people: TitleSuggestion["recommended_by"];
  secondDegree: number;
  action: ReasonAction;
}) {
  return (
    <>
      {people.length > 0 && (
        <p>
          {people.map((person) => person.display_name).join(", ")}{" "}
          {phrase(action, people.length === 1, false)}.
        </p>
      )}
      {secondDegree > 0 && (
        <p>
          {secondDegree}{" "}
          {secondDegree === 1 ? "friend of a friend" : "friends of friends"}{" "}
          {phrase(action, secondDegree === 1, people.length > 0)}.
        </p>
      )}
    </>
  );
}

const tooShort = "Enter at least two characters to search.";

export function TitleSearch({
  suggestions,
  serviceIds,
}: {
  suggestions: ViewingTitle<TitleSuggestion>[] | null;
  serviceIds: string[] | null;
}) {
  const interactive = useInteractive();
  // The URL holds the submitted query, so Back, Forward, and reloads restore
  // a search. Typing edits a draft until the viewer submits or clears it.
  const route = parseMemberRoute(`${usePathname()}?${useSearchParams()}`);
  const submitted = (route.kind === "search" && route.q) || "";
  const [query, setQuery] = useState(submitted);
  const [results, setResults] = useState<ViewingTitle[] | null>(
    submitted.length < 2 ? null : [],
  );
  const [myServices, setMyServices] = useState(false);
  const [searching, setSearching] = useState(submitted.length >= 2);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  // The query this view last searched for, or "" after clearing.
  const shown = useRef<string | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      pending.current = null;
      shown.current = null;
    },
    [],
  );
  useEffect(() => {
    if (shown.current === submitted) return;
    setQuery(submitted);
    void search(submitted);
  }, [submitted]);

  function changeQuery(value: string) {
    setQuery(value);
    if (value.trim()) return;
    // Clearing isn't a new search, so it replaces the current history entry.
    if (submitted)
      window.history.replaceState(null, "", memberPath({ kind: "search" }));
    void search("");
  }

  function submit() {
    const text = query.trim();
    if (text.length < 2) {
      setError(tooShort);
      return;
    }
    // Each new search adds a history entry; repeating one retries it.
    if (text !== submitted)
      window.history.pushState(
        null,
        "",
        memberPath({ kind: "search", q: text }),
      );
    void search(text);
  }

  async function search(text: string) {
    shown.current = text;
    pending.current?.abort();
    pending.current = null;
    setError("");
    if (text.length < 2) {
      setResults(null);
      setSearching(false);
      if (text) setError(tooShort);
      return;
    }
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(10_000);
    pending.current = controller;
    setSearching(true);
    setResults([]);
    try {
      const titles = await api<ViewingTitle[]>(
        `search?q=${encodeURIComponent(text)}`,
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

  const included = (title: ViewingTitle) =>
    !myServices ||
    (serviceIds !== null &&
      viewingAccess(title.viewing, serviceIds) === "available");
  const visibleResults = results?.filter(included);
  const visibleSuggestions = suggestions?.filter(included);
  const unknownCount = (results ?? suggestions ?? []).filter(
    (title) => viewingAccess(title.viewing, serviceIds ?? []) === "unknown",
  ).length;

  return (
    <>
      <div className="page-heading">
        <h1 className="page-title">Find a title</h1>
      </div>
      <form
        className="search-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
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
      <div className="service-filter">
        <button
          type="button"
          className={myServices ? "primary" : "secondary"}
          aria-pressed={myServices}
          disabled={!interactive || (serviceIds === null && !myServices)}
          onClick={() => setMyServices(!myServices)}
        >
          My services
        </button>
        <p className="small muted">
          Includes your saved services and free options.{" "}
          <Link href="/account" prefetch={false}>
            Edit services
          </Link>
        </p>
      </div>
      {myServices && unknownCount > 0 && (
        <p className="small muted" role="status">
          {unknownCount} {unknownCount === 1 ? "title has" : "titles have"}{" "}
          unknown viewing options. Turn off My services to see{" "}
          {unknownCount === 1 ? "it" : "them"}.
        </p>
      )}
      {myServices && serviceIds === null && (
        <p role="status">Your services could not be loaded. Try refreshing.</p>
      )}
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
          {visibleResults?.map((title) => (
            <TitleCard
              key={title.id}
              title={title}
              heading="h2"
              serviceIds={serviceIds ?? []}
            />
          ))}
          {!searching && !error && results.length === 0 && (
            <p className="empty">No matches. Try a different title.</p>
          )}
          {!searching &&
            !error &&
            results.length > 0 &&
            visibleResults?.length === 0 && (
              <p className="empty">
                No matches on your services or free. Turn off My services to see
                all results.
              </p>
            )}
        </section>
      ) : suggestions !== null ? (
        suggestions.length ? (
          <>
            <div className="section-heading">
              <h2>From your circle</h2>
            </div>
            <section className="suggestion-grid" aria-label="Title suggestions">
              {visibleSuggestions?.map((title) => (
                <Link
                  className="suggestion-tile"
                  key={title.id}
                  href={`/titles/${title.id.replace(":", "/")}?from=${
                    title.recommended_by.length
                      ? "suggestion_recommendation"
                      : "suggestion"
                  }`}
                  prefetch={false}
                >
                  <Poster
                    path={title.poster_path}
                    name={title.name}
                    sizes="(max-width: 560px) 45vw, 220px"
                  />
                  <h3>{title.name}</h3>
                  <TitleServices
                    viewing={title.viewing}
                    serviceIds={serviceIds ?? []}
                  />
                  <div className="suggestion-reasons">
                    <Reason
                      people={title.recommended_by}
                      secondDegree={title.second_degree_recommended}
                      action="recommended"
                    />
                    <Reason
                      people={title.wanted_by}
                      secondDegree={title.second_degree_wanted}
                      action="want_to_watch"
                    />
                    <Reason
                      people={title.watching_by}
                      secondDegree={title.second_degree_watching}
                      action="watching"
                    />
                  </div>
                </Link>
              ))}
            </section>
            {visibleSuggestions?.length === 0 && (
              <p className="empty">
                No suggestions on your services or free. Turn off My services to
                see all suggestions.
              </p>
            )}
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
      <ViewingAttribution />
    </>
  );
}
