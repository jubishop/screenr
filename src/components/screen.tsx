"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenData } from "../server/screens";
import type { Person, Title } from "../shared";
import { api, authClient, signOut, useInteractive, dateLabel } from "./client";
import { FeedView } from "./feed";
import { TitleCommentComposer } from "./title-comment";
import { Poster } from "./poster";
import { InvitationLink } from "./invitation-link";
import { WatchTogether } from "./watch-together";
import { TitleAvailability } from "./title-availability";

function titleURL(id: string) {
  return `/titles/${id.replace(":", "/")}`;
}
export function Screen({
  user,
  path,
  initialData,
  initialError,
  initialGoogleError,
}: {
  user: Person;
  path: string;
  initialData: ScreenData | null;
  initialError: string;
  initialGoogleError: string;
}) {
  const interactive = useInteractive();
  const [data, setData] = useState(initialData),
    [loadError, setLoadError] = useState(initialError),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [googleError, setGoogleError] = useState(initialGoogleError),
    [connectingGoogle, setConnectingGoogle] = useState(false);
  const [query, setQuery] = useState(""),
    [results, setResults] = useState<Title[] | null>(null),
    [inviteLimit, setInviteLimit] = useState(1);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(10_000);
    pending.current = controller;
    try {
      const latest = await api<ScreenData>(
        `screen?path=${encodeURIComponent(path)}`,
        undefined,
        AbortSignal.any([controller.signal, timeout]),
      );
      if (!controller.signal.aborted) {
        if (latest.kind === "redirect") {
          window.location.replace(latest.url);
          return;
        }
        setData(latest);
        setLoadError("");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setData(null);
        setLoadError(
          timeout.aborted
            ? "Refresh timed out. Please try again."
            : (error as Error).message,
        );
      }
    } finally {
      if (pending.current === controller) pending.current = null;
    }
  }, [path]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      // A slow request must finish before the next poll starts. Explicit
      // refreshes still supersede old reads after mutations or focus changes.
      if (document.visibilityState === "visible" && !pending.current)
        void refresh();
    }, 3000);
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      clearInterval(timer);
      pending.current?.abort();
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [refresh]);
  async function mutate(action: string, body: unknown) {
    pending.current?.abort();
    setBusy(true);
    setError("");
    try {
      const result = await api(action, body);
      await refresh();
      return result;
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function relationship(target: string, action: string) {
    await mutate("relationship", { target, action });
  }
  const own = (
    data && "conversations" in data ? (data.conversations ?? []) : []
  ).filter((c) => c.owner_id === user.user_id);
  function activity(title: string, field: string, value: boolean) {
    return mutate("activity", { title, field, value });
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link href="/" className="brand" prefetch={false}>
          screenr<span>●</span>
        </Link>
        <p className="sidebar-tagline">
          Good company.
          <br />
          Great things to watch.
        </p>
        <nav aria-label="Main navigation">
          {[
            ["/", "Your circle", "◉"],
            ["/search", "Find a title", "⌕"],
            ["/people", "Friends", "♧"],
            ["/invites", "Invite friends", "+"],
            ["/account", "Account", "○"],
          ].map(([href, label, icon]) => (
            <Link
              key={href}
              href={href}
              prefetch={false}
              className={path === href ? "active" : ""}
            >
              <span aria-hidden="true">{icon}</span>
              {label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link href={`/people/${user.username}`} prefetch={false}>
            <span className="avatar">{user.display_name.slice(0, 1)}</span>
            <span>
              {user.display_name}
              <small>@{user.username}</small>
            </span>
          </Link>
          <Link href="/credits" className="small muted">
            Catalog credits
          </Link>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <span className="eyebrow">YOUR PEOPLE. YOUR PICKS.</span>
          <span className="small muted">A private circle</span>
        </header>
        {loadError && (
          <div className="error" role="alert">
            {loadError}
            <button className="text-button" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
            <button className="text-button" onClick={() => setError("")}>
              Dismiss
            </button>
          </div>
        )}
        {data?.kind === "feed" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">THE FRIENDS FEED</p>
              <h1>Better with friends.</h1>
              <p>
                Fresh recommendations and familiar voices. Find your next great
                watch.
              </p>
            </div>
          </>
        )}
        {data?.kind === "title" && (
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
        {data?.kind === "search" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">FIND SOMETHING GOOD</p>
              <h1>What’s on your mind?</h1>
              <p>Search movies and shows, then see what your friends think.</p>
            </div>
            <form
              className="search-form"
              role="search"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError("");
                try {
                  setResults(
                    await api<Title[]>(`search?q=${encodeURIComponent(query)}`),
                  );
                } catch (error) {
                  setError((error as Error).message);
                } finally {
                  setBusy(false);
                }
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
                onChange={(e) => setQuery(e.target.value)}
              />
              <button className="primary" disabled={busy || !interactive}>
                {busy ? "Searching…" : "Search"}
              </button>
            </form>
            <div className="search-results">
              {results?.map((t) => (
                <Link
                  className="search-result"
                  key={t.id}
                  href={titleURL(t.id)}
                  prefetch={false}
                >
                  <Poster path={t.poster_path} name={t.name} />
                  <div>
                    <h2>{t.name}</h2>
                    <p className="muted">
                      {t.kind === "movie" ? "Movie" : "TV show"} ·{" "}
                      {t.release_date.slice(0, 4)}
                    </p>
                    <p className="small overview">{t.overview.slice(0, 150)}</p>
                  </div>
                  <span aria-hidden="true">↗</span>
                </Link>
              ))}
              {results?.length === 0 && (
                <p className="empty">No matches. Try a different title.</p>
              )}
            </div>
          </>
        )}
        {data?.kind === "people" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">GOOD COMPANY</p>
              <h1>Your friends.</h1>
              <p>Friendships start with a request and an acceptance.</p>
            </div>
            <form
              className="search-form"
              onSubmit={(e) => {
                e.preventDefault();
                window.location.assign(
                  `/people/${encodeURIComponent(query.trim().toLowerCase())}`,
                );
              }}
            >
              <label className="sr-only" htmlFor="friend-search">
                Exact username
              </label>
              <input
                disabled={!interactive}
                id="friend-search"
                placeholder="Find an exact username"
                value={query}
                required
                pattern="[a-zA-Z0-9_]{3,24}"
                onChange={(e) => setQuery(e.target.value)}
              />
              <button className="primary">Find person</button>
            </form>
            <div className="people-list">
              {data.connections.map((p) => (
                <article className="person-row" key={p.user_id}>
                  <Link href={`/people/${p.username}`} prefetch={false}>
                    <strong>{p.display_name}</strong>
                    <span className="muted"> @{p.username}</span>
                  </Link>
                  <div className="inline-actions">
                    {p.accepted_at ? (
                      <>
                        <span className="badge">Friends</span>
                        <button
                          className="text-button"
                          disabled={busy || !interactive}
                          onClick={() => void relationship(p.user_id, "remove")}
                        >
                          Unfriend
                        </button>
                      </>
                    ) : p.requested_by === user.user_id ? (
                      <>
                        <span className="small muted">Request sent</span>
                        <button
                          className="text-button"
                          disabled={busy || !interactive}
                          onClick={() => void relationship(p.user_id, "remove")}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="primary"
                          disabled={busy || !interactive}
                          onClick={() => void relationship(p.user_id, "accept")}
                        >
                          Accept
                        </button>
                        <button
                          className="text-button"
                          disabled={busy || !interactive}
                          onClick={() => void relationship(p.user_id, "remove")}
                        >
                          Decline
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
              {!data.connections.length && (
                <p className="empty">
                  Start with someone you know. Find their username or send an
                  invitation.
                </p>
              )}
            </div>
            {data.blocked.length > 0 && (
              <>
                <h2>Blocked people</h2>
                {data.blocked.map((p) => (
                  <div className="person-row" key={p.user_id}>
                    <span>{p.display_name}</span>
                    <button
                      className="text-button"
                      disabled={busy || !interactive}
                      onClick={() => void relationship(p.user_id, "unblock")}
                    >
                      Unblock
                    </button>
                  </div>
                ))}
              </>
            )}
          </>
        )}
        {data?.kind === "watch-together" && (
          <WatchTogether
            participants={data.participants}
            titles={data.titles}
          />
        )}
        {data?.kind === "profile" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">@{data.profile.username}</p>
              <h1>{data.profile.display_name}</h1>
              {data.profile.user_id !== user.user_id && (
                <div className="inline-actions">
                  {data.profile.accepted_at && (
                    <Link
                      className="primary button"
                      href={`/watch-together?with=${encodeURIComponent(data.profile.username)}`}
                      prefetch={false}
                    >
                      Watch together
                    </Link>
                  )}
                  {data.profile.accepted_at ? (
                    <button
                      className="secondary"
                      disabled={busy || !interactive}
                      onClick={() =>
                        void relationship(data.profile.user_id, "remove")
                      }
                    >
                      Unfriend
                    </button>
                  ) : data.profile.requested_by === user.user_id ? (
                    <button
                      className="secondary"
                      disabled={busy || !interactive}
                      onClick={() =>
                        void relationship(data.profile.user_id, "remove")
                      }
                    >
                      Cancel friend request
                    </button>
                  ) : data.profile.requested_by ? (
                    <button
                      className="primary"
                      disabled={busy || !interactive}
                      onClick={() =>
                        void relationship(data.profile.user_id, "accept")
                      }
                    >
                      Accept friend request
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={busy || !interactive}
                      onClick={() =>
                        void relationship(data.profile.user_id, "request")
                      }
                    >
                      Send friend request
                    </button>
                  )}
                  <button
                    className="text-button muted"
                    disabled={busy || !interactive}
                    onClick={() =>
                      void relationship(data.profile.user_id, "block")
                    }
                  >
                    Block
                  </button>
                </div>
              )}
            </div>
            {!data.profile.can_read && (
              <p className="empty">
                You’ll see their activity after you become friends.
              </p>
            )}
          </>
        )}
        {path.startsWith("/titles/") && (
          <TitleCommentComposer
            titleId={data?.kind === "title" ? data.title.id : null}
            refresh={refresh}
          />
        )}
        {(path === "/" ||
          path.startsWith("/titles/") ||
          /^\/people\/[^/?]+/.test(path)) && (
          <FeedView
            snapshot={
              data && "conversations" in data
                ? (data.conversations ?? null)
                : null
            }
            user={user}
            refresh={refresh}
            activity={activity}
            busy={busy}
            target={data?.kind === "title" ? data.target : null}
            unavailable={data?.kind === "title" && data.targetUnavailable}
            showEmpty={data?.kind !== "profile" || data.profile.can_read}
          />
        )}
        {data?.kind === "invites" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">MAKE ROOM FOR FRIENDS</p>
              <h1>Good things are shared.</h1>
              <p>
                Invite someone to Screenr. They can join for 30 days, then send
                a friend request.
              </p>
            </div>
            <form
              className="invite-form"
              onSubmit={async (e) => {
                e.preventDefault();
                await mutate("invite", { limit: inviteLimit });
              }}
            >
              <label>
                Maximum signups
                <select
                  disabled={!interactive}
                  value={inviteLimit}
                  onChange={(e) => setInviteLimit(Number(e.target.value))}
                >
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary" disabled={busy || !interactive}>
                Create invitation
              </button>
            </form>
            <div className="invite-list">
              {!data.invitations.length && (
                <p className="muted">No active invitations.</p>
              )}
              {data.invitations.map((invite) => (
                <article className="invite-card" key={invite.id}>
                  <div className="section-heading">
                    <strong>
                      {invite.uses} of {invite.max_uses} signups
                    </strong>
                    <button
                      className="text-button"
                      disabled={busy || !interactive}
                      onClick={() =>
                        void mutate("revoke-invite", { id: invite.id })
                      }
                    >
                      Revoke
                    </button>
                  </div>
                  <p className="small muted">
                    Expires {dateLabel(invite.expires_at, interactive)}
                  </p>
                  <InvitationLink key={invite.url} url={invite.url} />
                  <p>
                    {invite.joined.map((p: Person) => (
                      <Link
                        className="joined-person"
                        key={p.username}
                        href={`/people/${p.username}`}
                        prefetch={false}
                      >
                        {p.display_name} (@{p.username})
                      </Link>
                    ))}
                  </p>
                </article>
              ))}
            </div>
          </>
        )}
        {data?.kind === "account" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">YOUR ACCOUNT</p>
              <h1>One you. One circle.</h1>
              <p>
                Keep the same profile and friendships when you change sign-in
                methods.
              </p>
            </div>
            <section className="settings-card">
              <h2>Sign-in methods</h2>
              <p>
                Email codes sign you in to this same account. Use the email
                address you joined with.
              </p>
              {googleError && (
                <p className="error" role="alert">
                  {googleError}
                </p>
              )}
              {data.googleConnected ? (
                <p role="status">Google connected.</p>
              ) : data.googleEnabled ? (
                <>
                  <p>
                    Connect Google to add another way to sign in. Choose the
                    Google account with the same email address.
                  </p>
                  <button
                    className="secondary"
                    disabled={busy || connectingGoogle || !interactive}
                    onClick={async () => {
                      setConnectingGoogle(true);
                      setGoogleError("");
                      try {
                        const result = await authClient.linkSocial({
                          provider: "google",
                          callbackURL: "/account",
                          errorCallbackURL: "/account",
                          disableRedirect: true,
                        });
                        if (result.error)
                          throw new Error(
                            result.error.message ??
                              "Google could not be connected. Please try again.",
                          );
                        if (!result.data?.url)
                          throw new Error(
                            "Google sign-in did not start. Please try again.",
                          );
                        window.location.assign(result.data.url);
                      } catch (error) {
                        setGoogleError((error as Error).message);
                        setConnectingGoogle(false);
                      }
                    }}
                  >
                    {connectingGoogle ? "Connecting…" : "Connect Google"}
                  </button>
                </>
              ) : (
                <p className="muted">Google sign-in is not configured yet.</p>
              )}
              <hr />
              <button
                className="text-button"
                disabled={busy || !interactive || connectingGoogle}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await signOut();
                  } catch (error) {
                    setError((error as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Sign out
              </button>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
