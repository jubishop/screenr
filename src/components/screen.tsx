"use client";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenData } from "../server/screens";
import type { Conversation, Person, Title } from "../shared";
import { api, authClient, signOut, useInteractive, dateLabel } from "./client";
import { ThreadView } from "./thread";

function titleURL(id: string) {
  return `/titles/${id.replace(":", "/")}`;
}
function Poster({
  path,
  name,
  large = false,
}: {
  path: string | null;
  name: string;
  large?: boolean;
}) {
  return (
    <div className={`poster ${large ? "large" : ""}`}>
      {path ? (
        <Image
          src={`https://image.tmdb.org/t/p/w342${path}`}
          alt={`${name} poster`}
          fill
          sizes={large ? "180px" : "72px"}
        />
      ) : (
        <span aria-hidden="true">{name.slice(0, 1)}</span>
      )}
    </div>
  );
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
    [inviteLimit, setInviteLimit] = useState(1),
    [inviteURL, setInviteURL] = useState("");
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
  function cards(items: Conversation[]) {
    return items.length ? (
      <div className="feed-list">
        {items.map((c) => (
          <article className="activity-card" key={c.id}>
            <Link
              className="poster-link"
              href={titleURL(c.title_id)}
              prefetch={false}
            >
              <Poster path={c.poster_path} name={c.title_name} />
            </Link>
            <div className="activity-content">
              <p className="activity-by">
                <Link href={`/people/${c.username}`} prefetch={false}>
                  {c.display_name}
                </Link>
                <span className="muted">
                  {c.recommended
                    ? " recommends"
                    : c.want_to_watch
                      ? " wants to watch"
                      : " shared"}
                </span>
              </p>
              <h2>
                <Link href={titleURL(c.title_id)} prefetch={false}>
                  {c.title_name}
                </Link>
              </h2>
              <p className="small muted">
                {c.kind === "tv" ? "TV show" : "Movie"}
              </p>
              <div className="inline-actions">
                <Link
                  className="conversation-link"
                  href={`/conversations/${c.id}`}
                  prefetch={false}
                >
                  Open conversation <span aria-hidden="true">↗</span>
                </Link>
                {c.owner_id !== user.user_id && (
                  <button
                    className="text-button"
                    disabled={busy || !interactive}
                    onClick={() =>
                      void activity(
                        c.title_id,
                        "want_to_watch",
                        !c.viewer_want_to_watch,
                      )
                    }
                  >
                    {c.viewer_want_to_watch
                      ? "✓ Want to watch"
                      : "+ Want to watch"}
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}
      </div>
    ) : (
      <div className="empty-card">
        <h2>A little quiet, for now.</h2>
        <p>Your conversations and friends’ recommendations will appear here.</p>
        <Link className="text-button" href="/people">
          Find a friend →
        </Link>
      </div>
    );
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
            {cards(data.conversations)}
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
            <div className="section-heading">
              <h2>Around this title</h2>
              <span className="muted">Your circle’s conversations</span>
            </div>
            {cards(data.conversations)}
          </>
        )}
        {data?.kind === "thread" && (
          <>
            <div className="page-heading compact">
              <p className="eyebrow">
                A CONVERSATION WITH{" "}
                {data.conversation.display_name.toUpperCase()}
              </p>
              <h1>
                <Link
                  href={titleURL(data.conversation.title_id)}
                  prefetch={false}
                >
                  {data.conversation.title_name}
                </Link>
              </h1>
              <p>
                {data.conversation.recommended
                  ? `${data.conversation.display_name} recommends this ${data.conversation.kind === "tv" ? "show" : "movie"}.`
                  : "Something to talk about with friends."}
              </p>
            </div>
          </>
        )}
        {path.startsWith("/conversations/") && (
          <ThreadView
            key={path}
            snapshot={data?.kind === "thread" ? data : null}
            user={user}
            refresh={refresh}
          />
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
        {data?.kind === "profile" && (
          <>
            <div className="page-heading">
              <p className="eyebrow">@{data.profile.username}</p>
              <h1>{data.profile.display_name}</h1>
              {data.profile.user_id !== user.user_id && (
                <div className="inline-actions">
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
            {data.profile.can_read ? (
              cards(data.conversations)
            ) : (
              <p className="empty">
                You’ll see their activity after you become friends.
              </p>
            )}
          </>
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
                const result = await mutate("invite", { limit: inviteLimit });
                if (result?.token)
                  setInviteURL(
                    `${window.location.origin}/join/${result.token}`,
                  );
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
            {inviteURL && (
              <div className="invitation-created">
                <label>
                  Invitation link
                  <input
                    disabled={!interactive}
                    readOnly
                    value={inviteURL}
                    onFocus={(e) => e.target.select()}
                  />
                </label>
                <p className="small muted">
                  Copy this link now and share it with your friends.
                </p>
              </div>
            )}
            <div className="invite-list">
              {data.invitations.map((invite) => (
                <article className="invite-card" key={invite.id}>
                  <div className="section-heading">
                    <strong>
                      {invite.uses} of {invite.max_uses} signups
                    </strong>
                    {invite.revoked_at ? (
                      <span className="badge">Revoked</span>
                    ) : new Date(invite.expires_at) < new Date() ? (
                      <span className="badge">Expired</span>
                    ) : invite.uses >= invite.max_uses ? (
                      <span className="badge">Used up</span>
                    ) : (
                      <button
                        className="text-button"
                        disabled={busy || !interactive}
                        onClick={() =>
                          void mutate("revoke-invite", { id: invite.id })
                        }
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                  <p className="small muted">
                    Expires {dateLabel(invite.expires_at, interactive)}
                  </p>
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
