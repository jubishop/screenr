"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenData } from "../server/screens";
import type { Person } from "../shared";
import { api, signOut } from "./client";
import { FeedView } from "./feed";
import { WatchTogether } from "./watch-together";
import { TitleSearch } from "./title-search";
import { AccountView } from "./account-view";
import { InvitationsView } from "./invitations-view";
import { PeopleView } from "./people-view";
import { ProfileView } from "./profile-view";
import { TitleView } from "./title-view";

export function Screen({
  user: initialUser,
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
  const [user, setUser] = useState(initialUser);
  const [data, setData] = useState(initialData),
    [loadError, setLoadError] = useState(initialError),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(10_000);
    pending.current = controller;
    try {
      const latest = await api<ScreenData & { user: Person }>(
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
        setUser(latest.user);
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
  async function signOutOfAccount() {
    setBusy(true);
    setError("");
    try {
      await signOut();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function relationship(target: string, action: string) {
    await mutate("relationship", { target, action });
  }
  async function saveDisplayName(name: string) {
    pending.current?.abort();
    const updated = await api<Person>("display-name", { name });
    setUser(updated);
    await refresh();
  }
  async function saveProfile(name: string, username: string) {
    pending.current?.abort();
    const updated = await api<Person>("profile", { name, username });
    setUser(updated);
    await refresh();
  }
  const ownProfile =
    path.split("?")[0].toLowerCase() === `/people/${user.username}`;
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
        {/* Keep draft-owning views mounted while failed reads clear their data. */}
        {path.startsWith("/titles/") && (
          <TitleView
            data={data?.kind === "title" ? data : null}
            user={user}
            busy={busy}
            activity={activity}
            refresh={refresh}
          />
        )}
        {path.split("?")[0] === "/search" && (
          <TitleSearch
            suggestions={data?.kind === "search" ? data.suggestions : null}
          />
        )}
        {path.split("?")[0] === "/people" && (
          <PeopleView
            data={data?.kind === "people" ? data : null}
            user={user}
            busy={busy}
            relationship={relationship}
          />
        )}
        {data?.kind === "watch-together" && (
          <WatchTogether
            participants={data.participants}
            titles={data.titles}
          />
        )}
        {(ownProfile || data?.kind === "profile") && (
          <ProfileView
            data={data?.kind === "profile" ? data : null}
            user={user}
            ownProfile={ownProfile}
            busy={busy}
            relationship={relationship}
            saveDisplayName={saveDisplayName}
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
        {path.split("?")[0] === "/invites" && (
          <InvitationsView
            data={data?.kind === "invites" ? data : null}
            busy={busy}
            mutate={mutate}
          />
        )}
        {path.split("?")[0] === "/account" && (
          <AccountView
            data={data?.kind === "account" ? data : null}
            user={user}
            busy={busy}
            initialGoogleError={initialGoogleError}
            saveProfile={saveProfile}
            onSignOut={signOutOfAccount}
          />
        )}
      </main>
    </div>
  );
}
