"use client";
import {
  Link,
  NavigationReports,
  usePendingNavigations,
} from "./pending-navigation";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ScreenData } from "../server/screens";
import type { Person, SaveSurface, WatchStatus } from "../shared";
import {
  memberPath,
  memberTitle,
  parseMemberRoute,
  type MemberRoute,
} from "../member-routes";
import { api, ApiError, isPermanent, readChanged } from "./client";
import { Avatar } from "./avatar";
import { Icon, type IconName } from "./icons";
import { FeedView } from "./feed";
import { WatchTogether } from "./watch-together";
import { TitleSearch } from "./title-search";
import { AccountView } from "./account-view";
import { sendPhoto, type PhotoChange } from "./photo-editor";
import { InvitationsView } from "./invitations-view";
import { PeopleView } from "./people-view";
import { ProfileView } from "./profile-view";
import { TitleView } from "./title-view";
import { StartConversation } from "./start-conversation";
import { Notifications } from "./notifications";
import { leaveNotice } from "./page-notice";

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

// A missing page responds 404 through the not-found view, which receives no
// route props. Its screen reads the requested path in the browser, and its
// first read shows why the page is missing, such as "Person not found."
export function MissingScreen({ user }: { user: Person }) {
  const pathname = usePathname();
  const query = useSearchParams();
  const path = memberPath(parseMemberRoute(`${pathname}?${query}`));
  return (
    <Screen
      key={path}
      user={user}
      path={path}
      initialData={null}
      initialVersion={null}
      initialError=""
      initialGoogleError=""
    />
  );
}

// Focus a heading or the main region only until it loses focus, so it never
// becomes a Tab stop or catches later clicks.
function focusOnce(target: HTMLElement, options?: FocusOptions) {
  if (!target.hasAttribute("tabindex")) {
    target.tabIndex = -1;
    target.addEventListener("blur", () => target.removeAttribute("tabindex"), {
      once: true,
    });
  }
  target.focus(options);
}

// Each route mounts a new screen. The first one in a document keeps the
// browser's focus; later ones come from client navigation.
let screensShown = 0;

export function Screen({
  user: initialUser,
  path,
  initialData,
  initialVersion,
  initialError,
  initialStatus,
  initialGoogleError,
}: {
  user: Person;
  path: string;
  initialData: ScreenData | null;
  // The version of the screen response that brought initialData.
  initialVersion: string | null;
  initialError: string;
  // The page load's status, when it already read this screen.
  initialStatus?: number;
  initialGoogleError: string;
}) {
  const [user, setUser] = useState(initialUser);
  const [data, setData] = useState(initialData),
    [loadError, setLoadError] = useState(initialError),
    [busy, setBusy] = useState(false);
  // Reads can rename a title or person, and a missing page is titled Page not
  // found. Other failed reads keep the last title.
  const [pageTitle, setPageTitle] = useState(() =>
    memberTitle(parseMemberRoute(path), initialData),
  );
  const router = useRouter();
  const [navigating, reportNavigation] = usePendingNavigations();
  const pending = useRef<AbortController | null>(null);
  // Set while a write makes this page unreadable, so no refresh reads it.
  const leaving = useRef(false);
  // Polling stops after a permanent error, such as a missing page, and
  // resumes after the next successful read. Until then only the reader's
  // actions read again: Try again, returning to the page, a write, or
  // navigation.
  const stopped = useRef(isPermanent(initialStatus));
  const main = useRef<HTMLElement>(null);
  // After client navigation, focus the new page's heading, or the main region
  // when an error replaces it, so screen readers announce the page and
  // keyboard users continue from it. Refreshes keep focus, and linked entries
  // keep their scroll position.
  const screenNumber = useRef(0);
  useEffect(() => {
    screenNumber.current ||= ++screensShown;
    if (screenNumber.current === 1 || !main.current) return;
    focusOnce(main.current.querySelector("h1") ?? main.current, {
      preventScroll: true,
    });
  }, []);
  // The version of the shown screen, or null when none is shown or the reply
  // had none. Refreshes send it, and an unchanged screen answers 304, which
  // keeps the current data without rendering again.
  const version = useRef(initialVersion);
  const refresh = useCallback(async () => {
    if (leaving.current) return;
    pending.current?.abort();
    const controller = new AbortController();
    const timeout = AbortSignal.timeout(10_000);
    pending.current = controller;
    try {
      const latest = await readChanged<ScreenData & { user: Person }>(
        `screen?path=${encodeURIComponent(path)}`,
        version.current,
        AbortSignal.any([controller.signal, timeout]),
      );
      if (!controller.signal.aborted) {
        if (latest?.data.kind === "redirect") {
          window.location.replace(latest.data.url);
          return;
        }
        stopped.current = false;
        if (!latest) return;
        version.current = latest.version;
        setData(latest.data);
        setPageTitle(memberTitle(parseMemberRoute(path), latest.data));
        setUser(latest.data.user);
        setLoadError("");
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        version.current = null;
        stopped.current =
          error instanceof ApiError && isPermanent(error.status);
        if (error instanceof ApiError && error.status === 404)
          setPageTitle(memberTitle({ kind: "not-found", path }, null));
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
    // The page load brings the first screen. Without one, such as after a
    // failed load or on the not-found view, the page reads it now.
    if (version.current === null && !stopped.current) void refresh();
    const timer = setInterval(() => {
      // A slow request must finish before the next poll starts. Explicit
      // refreshes still supersede old reads after mutations or a return.
      if (
        document.visibilityState === "visible" &&
        !pending.current &&
        !stopped.current
      )
        void refresh();
    }, 3000);
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(timer);
      pending.current?.abort();
      document.removeEventListener("visibilitychange", visible);
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
  // Blocking hides the profile, so a confirmed Block opens Friends with its
  // result instead of refreshing a page that no longer loads. The page stays
  // busy until it changes.
  async function block(person: Person) {
    leaving.current = true;
    pending.current?.abort();
    setBusy(true);
    try {
      await api("relationship", { target: person.user_id, action: "block" });
    } catch (error) {
      leaving.current = false;
      setBusy(false);
      throw error;
    }
    leaveNotice("/people", `You blocked ${person.display_name}.`);
    router.push("/people");
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
  async function savePhoto(change: PhotoChange) {
    pending.current?.abort();
    const { photo } = await sendPhoto(change);
    setUser((current) => ({ ...current, photo }));
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
  // The title page friend line asks the feed to show a friend's entry. Each
  // request is a new object, so choosing the same name again still scrolls.
  const [shownEntry, setShownEntry] = useState<{ item: string } | null>(null);
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
  function watchStatus(
    title: string,
    status: WatchStatus | null,
    finishedOn?: string,
    surface?: SaveSurface,
  ) {
    return mutate("watch-status", { title, status, finishedOn, surface });
  }
  function finishedDate(title: string, date: string | null) {
    return mutate("finished-date", { title, date });
  }
  const shell = (
    <div className="app-shell">
      {/* React places the title in the document head. */}
      <title>{pageTitle}</title>
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          if (!main.current) return;
          event.preventDefault();
          focusOnce(main.current);
        }}
      >
        Skip to main content
      </a>
      {/* The current screen stays while the next one renders on the server. */}
      {navigating && (
        <div
          className="navigation-progress"
          role="progressbar"
          aria-label="Loading page"
        />
      )}
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
      <main
        className="main"
        id="main-content"
        ref={main}
        aria-busy={navigating || undefined}
      >
        {loadError && (
          <div className="error" role="alert">
            {loadError}
            <button className="text-button" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        )}
        {/* Keep draft-owning views mounted while failed reads clear their data. */}
        {route.kind === "feed" && (
          <StartConversation
            title={null}
            available={data?.kind === "feed"}
            refresh={refresh}
          />
        )}
        {route.kind === "title" && (
          <TitleView
            data={data?.kind === "title" ? data : null}
            user={user}
            busy={busy}
            activity={activity}
            watchStatus={watchStatus}
            finishedDate={finishedDate}
            refresh={refresh}
            showEntry={(item) => setShownEntry({ item })}
          />
        )}
        {route.kind === "search" && (
          <TitleSearch
            suggestions={data?.kind === "search" ? data.suggestions : null}
            recommendations={
              data?.kind === "search" ? data.recommendations : null
            }
            serviceIds={data?.kind === "search" ? data.serviceIds : null}
            activity={activity}
            busy={busy}
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
            viewerHasServices={data.viewerHasServices}
          />
        )}
        {route.kind === "profile" && (
          <ProfileView
            data={data?.kind === "profile" ? data : null}
            user={user}
            ownProfile={ownProfile}
            busy={busy}
            relationship={relationship}
            block={block}
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
            target={data && "target" in data ? data.target : null}
            unavailable={!!data && "target" in data && data.targetUnavailable}
            showEmpty={data?.kind !== "profile" || data.profile.can_read}
            compact={route.kind === "title"}
            shownEntry={route.kind === "title" ? shownEntry : null}
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
            savePhoto={savePhoto}
            saveServices={saveServices}
            refresh={refresh}
          />
        )}
      </main>
    </div>
  );
  // Links and notifications in this screen report their pending navigations.
  return (
    <NavigationReports value={reportNavigation}>{shell}</NavigationReports>
  );
}
