"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenData } from "../server/screens";
import type { Person, SaveSurface } from "../shared";
import { parseMemberRoute, type MemberRoute } from "../member-routes";
import { api } from "./client";
import { Avatar } from "./avatar";
import { Icon, type IconName } from "./icons";
import { FeedView } from "./feed";
import { WatchTogether } from "./watch-together";
import { TitleSearch } from "./title-search";
import { AccountView } from "./account-view";
import { InvitationsView } from "./invitations-view";
import { PeopleView } from "./people-view";
import { ProfileView } from "./profile-view";
import { TitleView } from "./title-view";
import { Notifications } from "./notifications";

// The phone bottom bar shows the short labels; the sidebar shows full names.
const sections: {
  href: string;
  label: string;
  short: string;
  icon: IconName;
}[] = [
  { href: "/", label: "Your circle", short: "Circle", icon: "circle" },
  { href: "/search", label: "Find a title", short: "Find", icon: "search" },
  { href: "/people", label: "Friends", short: "Friends", icon: "friends" },
  { href: "/account", label: "Account", short: "Account", icon: "account" },
];

// Invitations open from the Friends page, so Friends stays the current section.
function currentSection(route: MemberRoute, href: string) {
  const section = parseMemberRoute(href).kind;
  if (route.kind === section) return "page";
  if (section === "people" && route.kind === "invites") return "true";
  return undefined;
}

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
  // A failed write rejects, so its caller shows the error beside the control.
  async function mutate(action: string, body: unknown) {
    pending.current?.abort();
    setBusy(true);
    try {
      const result = await api(action, body);
      await refresh();
      return result;
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
  async function saveServices(serviceIds: string[]) {
    pending.current?.abort();
    const saved = await api<{ serviceIds: string[] }>("streaming-services", {
      serviceIds,
    });
    setData((current) =>
      current?.kind === "account" ? { ...current, ...saved } : current,
    );
    await refresh();
  }
  const route = parseMemberRoute(path);
  const ownProfile =
    route.kind === "profile" && route.username.toLowerCase() === user.username;
  function activity(
    title: string,
    field: string,
    value: boolean,
    surface?: SaveSurface,
  ) {
    return mutate("activity", { title, field, value, surface });
  }
  return (
    <div className="app-shell">
      <header className="sidebar">
        <div className="brand-row">
          <Link href="/" className="brand" prefetch={false}>
            screenr<span>●</span>
          </Link>
          <div className="header-actions">
            <Notifications
              count={
                data && "unreadNotifications" in data
                  ? data.unreadNotifications
                  : null
              }
              refreshScreen={refresh}
            />
            {/* Phones hide the sidebar link, so the header links the profile. */}
            <Link
              href={`/people/${user.username}`}
              className="header-profile"
              aria-label="Your profile"
              prefetch={false}
            >
              <Avatar person={user} />
            </Link>
          </div>
        </div>
        <nav className="main-nav" aria-label="Main navigation">
          {sections.map(({ href, label, short, icon }) => (
            <Link
              key={href}
              href={href}
              prefetch={false}
              aria-current={currentSection(route, href)}
            >
              <span className="nav-icon">
                <Icon name={icon} />
              </span>
              {short === label ? (
                <span>{label}</span>
              ) : (
                <>
                  <span className="nav-full">{label}</span>
                  <span className="nav-short">{short}</span>
                </>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Link href={`/people/${user.username}`} prefetch={false}>
            <Avatar person={user} />
            <span>
              {user.display_name}
              <small>@{user.username}</small>
            </span>
          </Link>
          <Link href="/credits" className="small muted">
            Catalog credits
          </Link>
        </div>
      </header>
      <main className="main">
        {loadError && (
          <div className="error" role="alert">
            {loadError}
            <button className="text-button" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
        {data?.kind === "feed" && (
          <div className="page-heading">
            <h1 className="page-title">Your circle</h1>
          </div>
        )}
        {/* Keep draft-owning views mounted while failed reads clear their data. */}
        {route.kind === "title" && (
          <TitleView
            data={data?.kind === "title" ? data : null}
            user={user}
            busy={busy}
            activity={activity}
            refresh={refresh}
          />
        )}
        {route.kind === "search" && (
          <TitleSearch
            suggestions={data?.kind === "search" ? data.suggestions : null}
            serviceIds={data?.kind === "search" ? data.serviceIds : null}
          />
        )}
        {route.kind === "people" && (
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
        {route.kind === "profile" && (
          <ProfileView
            data={data?.kind === "profile" ? data : null}
            user={user}
            ownProfile={ownProfile}
            busy={busy}
            relationship={relationship}
            saveDisplayName={saveDisplayName}
          />
        )}
        {(route.kind === "feed" ||
          route.kind === "title" ||
          route.kind === "profile") && (
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
        {route.kind === "invites" && (
          <InvitationsView
            data={data?.kind === "invites" ? data : null}
            busy={busy}
            mutate={mutate}
          />
        )}
        {route.kind === "account" && (
          <AccountView
            data={data?.kind === "account" ? data : null}
            user={user}
            initialGoogleError={initialGoogleError}
            saveProfile={saveProfile}
            saveServices={saveServices}
            refresh={refresh}
          />
        )}
      </main>
    </div>
  );
}
