"use client";
import { Link } from "./pending-navigation";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type {
  AccessTitle,
  FriendsRecommendation,
  SaveSurface,
  TitleSuggestion,
} from "../shared";
import {
  memberPath,
  parseMemberRoute,
  type FindFilters,
  type SearchTab,
} from "../member-routes";
import { TitleServices, ViewingAttribution } from "./title-services";
import { anySignal, api, useInteractive } from "./client";
import { Poster } from "./poster";
import { TitleCard } from "./title-card";
import { TitleStatus } from "./title-status";
import { FriendsRecommend, withFinished } from "./friends-recommend";
import { ofKind, type TitleKindFilter } from "./title-kind-filter";

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

// Direct friends by name, recommenders with their top 10 rank, as in
// "Maya Chen (#1)"; friends of friends only as a count.
function Reason({
  people,
  secondDegree,
  action,
}: {
  people: (TitleSuggestion["wanted_by"][number] & { rank?: number | null })[];
  secondDegree: number;
  action: ReasonAction;
}) {
  return (
    <>
      {people.length > 0 && (
        <p>
          {people
            .map(
              (person) =>
                person.display_name + (person.rank ? ` (#${person.rank})` : ""),
            )
            .join(", ")}{" "}
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

const tabs: { tab?: SearchTab; label: string }[] = [
  { label: "Suggestions" },
  { tab: "friends-recommend", label: "Friends recommend" },
];

// Find a title's tabs change the URL in place, like a submitted search, so
// both keep their state. Before the page is interactive, and when opened in a
// new tab or window, each is an ordinary link.
function TabLink({
  tab,
  current,
  label,
}: {
  tab?: SearchTab;
  current: boolean;
  label: string;
}) {
  const href = memberPath({ kind: "search", tab });
  return (
    <a
      href={href}
      aria-current={current ? "page" : undefined}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        if (!current) window.history.pushState(null, "", href);
      }}
    >
      {label}
    </a>
  );
}

export function TitleSearch({
  suggestions,
  recommendations,
  hiddenFinished,
  filters,
  setFilters,
  serviceIds,
  activity,
  busy,
}: {
  suggestions: AccessTitle<TitleSuggestion>[] | null;
  recommendations: AccessTitle<FriendsRecommendation>[] | null;
  // Friends recommend titles the server left out as finished.
  hiddenFinished: number;
  // The screen's filters, which its reads send to the server.
  filters: FindFilters;
  setFilters: (change: (filters: FindFilters) => FindFilters) => void;
  serviceIds: string[] | null;
  activity: (
    title: string,
    field: string,
    value: boolean,
    surface?: SaveSurface,
  ) => Promise<unknown>;
  busy: boolean;
}) {
  const interactive = useInteractive();
  // The URL holds the submitted query and the tab, so Back, Forward, and
  // reloads restore them. Typing edits a draft until the viewer submits or
  // clears it.
  const route = parseMemberRoute(`${usePathname()}?${useSearchParams()}`);
  const submitted = (route.kind === "search" && route.q) || "";
  const tab = route.kind === "search" ? route.tab : undefined;
  // The filters keep their state across tabs. Friends recommend's own start
  // with finished titles hidden on each visit. The lists arrive filtered and
  // capped; filtering them here too also covers search results and the lists
  // read before a filter changed, until the screen reads them again.
  const kind: TitleKindFilter = filters.type ?? "all";
  const setKind = (kind: TitleKindFilter) =>
    setFilters((filters) => ({
      ...filters,
      type: kind === "all" ? undefined : kind,
    }));
  const showFinished = filters.finished !== "hidden";
  const setShowFinished = (show: boolean) =>
    setFilters((filters) => ({
      ...filters,
      finished: show ? undefined : "hidden",
    }));
  const myServices = filters.services === "mine";
  const setMyServices = (on: boolean) =>
    setFilters((filters) => ({
      ...filters,
      services: on ? "mine" : undefined,
    }));
  const [query, setQuery] = useState(submitted);
  const [results, setResults] = useState<AccessTitle[] | null>(
    submitted.length < 2 ? null : [],
  );
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
  // Each result carries the viewer's access for the services saved when it
  // was searched. When a screen read brings other saved services, as after a
  // change in another tab, the results showing search again. They stay until
  // the new ones arrive, and a failed search keeps them.
  const services = serviceIds?.join(" ") ?? null;
  const searchedServices = useRef(services);
  useEffect(() => {
    if (services === null) return;
    const previous = searchedServices.current;
    searchedServices.current = services;
    const text = shown.current;
    if (
      previous !== null &&
      previous !== services &&
      text &&
      text.length >= 2 &&
      !pending.current &&
      !error
    )
      void search(text, true);
  }, [services]);

  function changeQuery(value: string) {
    setQuery(value);
    if (value.trim()) return;
    // Clearing isn't a new search, so it replaces the current history entry.
    if (submitted)
      window.history.replaceState(
        null,
        "",
        memberPath({ kind: "search", tab }),
      );
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
        memberPath({ kind: "search", tab, q: text }),
      );
    void search(text);
  }

  async function search(text: string, keepingResults = false) {
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
    if (!keepingResults) {
      setSearching(true);
      setResults([]);
    }
    try {
      const titles = await api<AccessTitle[]>(
        `search?q=${encodeURIComponent(text)}`,
        undefined,
        anySignal([controller.signal, timeout]),
      );
      if (pending.current === controller) setResults(titles);
    } catch (error) {
      if (pending.current === controller && !keepingResults)
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

  // Each title arrives with the viewer's access to it.
  const included = (title: AccessTitle) =>
    !myServices || title.access === "available";
  const visibleResults = results?.filter(included);
  const visibleSuggestions = suggestions?.filter(included);
  const listed: AccessTitle[] =
    results ??
    (tab
      ? recommendations?.filter(ofKind(kind)).filter(withFinished(showFinished))
      : suggestions) ??
    [];
  const unknownCount = listed.filter(
    (title) => title.access === "unknown",
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
        <input
          disabled={!interactive}
          aria-label="Movie or show title"
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
        <p className="small muted">
          {unknownCount} {unknownCount === 1 ? "title has" : "titles have"}{" "}
          unknown viewing options. Turn off My services to see{" "}
          {unknownCount === 1 ? "it" : "them"}.
        </p>
      )}
      {myServices && serviceIds === null && (
        <p>Your services could not be loaded. Try refreshing.</p>
      )}
      {error && <div className="error">{error}</div>}
      {results !== null ? (
        <section className="search-results" aria-label="Search results">
          {visibleResults?.map((title) => (
            <TitleCard key={title.id} title={title} heading="h2" />
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
      ) : (
        <nav className="view-tabs" aria-label="Find a title lists">
          {tabs.map((option) => (
            <TabLink
              key={option.label}
              tab={option.tab}
              current={option.tab === tab}
              label={option.label}
            />
          ))}
        </nav>
      )}
      {results === null && tab && recommendations !== null && (
        <FriendsRecommend
          recommendations={recommendations}
          hiddenFinished={hiddenFinished}
          kind={kind}
          setKind={setKind}
          showFinished={showFinished}
          setShowFinished={setShowFinished}
          included={included}
          myServices={myServices}
          activity={activity}
          busy={busy}
        />
      )}
      {results !== null || tab ? null : suggestions !== null ? (
        // With My services on, the server lists only matching suggestions,
        // so an empty list explains the filter.
        suggestions.length || myServices ? (
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
                  <TitleStatus
                    release={title.release}
                    score={title.tmdb_score}
                  />
                  <TitleServices
                    viewing={title.viewing}
                    matchingServiceIds={title.matchingServiceIds}
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
