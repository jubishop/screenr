import { createHash } from "node:crypto";
import { profileFor } from "./profiles";
import { people } from "./relationships";
import {
  conversations,
  conversationURL,
  feedPage,
  friendActivity,
  linkTarget,
  type FeedWindow,
} from "./feed";
import {
  getTitleAvailability,
  getTitleTrailer,
  getTitleWithRelease,
} from "./catalog";
import { listInvitations } from "./invitations";
import { AppError, db, settleAll } from "./db";
import { watchTogether } from "./watch-together";
import { wantToWatch } from "./want-to-watch";
import { titleSuggestions } from "./title-suggestions";
import { friendsRecommend } from "./friends-recommend";
import { savedServices, streamingServices } from "./streaming-services";
import { withViewingOptions } from "./title-viewing";
import { serviceProviders } from "./watch-sources";
import { activityEmail, unreadNotifications } from "./notifications";
import { pushSettings } from "./push";
import { appleConfigured } from "./apple";
import { logFailure, withRequest } from "./log";
import { watchStatus } from "./title-actions";
import { topTen, topTenRanks } from "./top-ten";
import {
  parseMemberRoute,
  type HistoryWindow,
  type MemberRoute,
} from "../member-routes";
import type { Person, Title } from "../shared";

export async function loadScreen(userId: string, requestedPath: string) {
  const [content, unread] = await settleAll([
    loadContent(userId, parseMemberRoute(requestedPath)),
    unreadNotifications(userId),
  ]);
  return content.kind === "redirect"
    ? content
    : { ...content, unreadNotifications: unread };
}

// The screen API responds with the screen and the reader's own profile.
export function screenResponse(screen: ScreenData, user: Person) {
  return { ...screen, user };
}

// Successful API reads send this weak ETag of their exact JSON body. It covers
// everything the reader receives, including their own profile, so a reader
// that holds the same version already holds the same body. The member page
// sends its first screen's version, and screen refreshes send back the
// version they hold, so an unchanged screen answers 304 without a body.
export function readVersion(body: string) {
  return `W/"${createHash("sha256").update(body).digest("base64url")}"`;
}

// The member page loads its first screen on the server. A failure shows its
// message in the page instead of an error page, and its status tells the page
// to respond 404 and the browser whether to keep polling. Unexpected failures
// are logged with the route kind, not the path, which can name people or
// search terms. The page load counts as one request for failures logged once.
export function initialScreen(userId: string, requestedPath: string) {
  return withRequest(async () => {
    try {
      return {
        data: await loadScreen(userId, requestedPath),
        error: "",
        status: 200,
      };
    } catch (error) {
      if (error instanceof AppError)
        return { data: null, error: error.message, status: error.status };
      logFailure(
        "page failed",
        { route: parseMemberRoute(requestedPath).kind },
        error,
      );
      return {
        data: null,
        error: "This page could not load. Please try again.",
        status: 500,
      };
    }
  });
}

// The window a paged feed or profile read names, or null for a read of the
// whole history. A time that does not parse reads the newest page.
function historyWindow({ since, before }: HistoryWindow): FeedWindow | null {
  const time = (value?: string) => {
    const parsed = value ? new Date(value) : null;
    return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
  };
  if (since) {
    const at = time(since);
    return at ? { since: at } : { before: Infinity };
  }
  if (before) return { before: time(before) ?? Infinity };
  return null;
}

// A paged read adds the window it sent and whether older entries remain
// (docs/title-feed.md#paged-histories); a read of the whole history, as from
// installed iPhone builds, sends the same fields as before.
const paged = (page: { since: string | null; older: boolean } | null) =>
  page && { since: page.since, older: page.older };

async function loadContent(userId: string, route: MemberRoute) {
  if (route.kind === "feed") {
    // Links to posts without a title open them here, even when the entry is
    // older than the page.
    const window = historyWindow(route);
    const page = window && (await feedPage(userId, window, route));
    const threads = page?.conversations ?? (await conversations(userId));
    return {
      kind: "feed" as const,
      conversations: threads,
      ...linkTarget(threads, route),
      ...paged(page),
    };
  }
  if (route.kind === "search") {
    // Both Find a title tabs load together, so switching tabs needs no new
    // read, and one availability and release read covers titles on either
    // list. Each list is capped, with the read's filters applied first
    // (docs/title-suggestions.md#implementation), and only listed titles
    // read or refresh viewing options.
    const serviceIds = await savedServices(userId);
    const services =
      route.services === "mine" ? serviceProviders(serviceIds) : null;
    const hideFinished = route.finished === "hidden";
    const [suggestions, { titles: recommendations, finished }] =
      await settleAll([
        titleSuggestions(userId, services),
        friendsRecommend(userId, { type: route.type, services, hideFinished }),
      ]);
    const listed = new Map(
      (await withViewingOptions([...suggestions, ...recommendations])).map(
        ({ id, viewing, release, tmdb_score }) => [
          id,
          { viewing, release, tmdb_score },
        ],
      ),
    );
    const withViewing = <T extends Title>(titles: T[]) =>
      titles.map((title) => ({ ...title, ...listed.get(title.id)! }));
    return {
      kind: "search" as const,
      suggestions: withViewing(suggestions),
      recommendations: withViewing(recommendations),
      serviceIds,
      // How many Friends recommend titles the read left out because the
      // viewer finished them. Only a read that hides them has it, so
      // installed iPhone builds, which hide them themselves, get the same
      // fields as before.
      ...(hideFinished && { finishedRecommendations: finished }),
    };
  }
  if (route.kind === "people")
    return { kind: "people" as const, ...(await people(userId)) };
  if (route.kind === "watch-together") {
    const usernames = route.with;
    if (usernames.length !== 1 || !usernames[0])
      throw new AppError("Choose one friend from their profile.");
    return {
      kind: "watch-together" as const,
      ...(await watchTogether(userId, usernames, route.mode)),
    };
  }
  if (route.kind === "invites")
    return {
      kind: "invites" as const,
      invitations: await listInvitations(userId),
    };
  if (route.kind === "account")
    return {
      kind: "account" as const,
      // Where sign-in codes go, including the one that confirms deletion.
      email: (
        await db.query<{ email: string }>(
          'SELECT email FROM "user" WHERE id=$1',
          [userId],
        )
      ).rows[0].email,
      activityEmail: await activityEmail(userId),
      // The iPhone app's per-kind push settings.
      pushSettings: await pushSettings(userId),
      services: streamingServices,
      serviceIds: await savedServices(userId),
      googleEnabled: !!(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ),
      googleConnected: !!(
        await db.query(
          'SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"=$2 LIMIT 1',
          [userId, "google"],
        )
      ).rowCount,
      // Sign in with Apple, which only the iPhone app offers and links.
      appleEnabled: appleConfigured(),
      appleConnected: !!(
        await db.query(
          'SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"=$2 LIMIT 1',
          [userId, "apple"],
        )
      ).rowCount,
    };
  if (route.kind === "title") {
    const { id } = route;
    // Catalog requests run together to fit the client's refresh deadline.
    const stored = getTitleWithRelease(id);
    const [
      { title, release, tmdb_score },
      threads,
      trailer,
      availability,
      watch,
      own,
      ranks,
    ] = await settleAll([
      stored,
      conversations(userId, { title: id }),
      getTitleTrailer(id, stored),
      getTitleAvailability(id, Infinity, stored),
      watchStatus(userId, id),
      topTen(userId),
      topTenRanks(id),
    ]);
    return {
      kind: "title" as const,
      title,
      trailer,
      availability,
      // The US release status shown beside Where to watch, with the TMDB
      // user score beside it.
      release,
      tmdb_score,
      watch,
      // The viewer's own top 10, for its control and full-list prompt.
      topTen: own,
      conversations: threads,
      friends: friendActivity(userId, threads, ranks),
      ...linkTarget(threads, route),
    };
  }
  if (route.kind === "profile") {
    const profile = await profileFor(userId, route.username);
    const window = historyWindow(route);
    const owner = { owner: profile.user_id };
    // The top 10 is visible to every member who can see the profile; the
    // entries and discussions behind it stay friends-only.
    const [list, page] = await settleAll([
      topTen(profile.user_id),
      !profile.can_read
        ? { conversations: [], since: null, older: false }
        : window
          ? feedPage(userId, window, owner)
          : conversations(userId, owner).then((all) => ({
              conversations: all,
              since: null,
              older: false,
            })),
    ]);
    return {
      kind: "profile" as const,
      profile,
      topTen: list,
      conversations: page.conversations,
      ...paged(window && page),
    };
  }
  if (route.kind === "want-to-watch")
    return {
      kind: "want-to-watch" as const,
      ...(await wantToWatch(userId, route.username, route.mode)),
    };
  if (route.kind === "conversation")
    return {
      kind: "redirect" as const,
      url: await conversationURL(userId, route.id, route.reply),
    };
  throw new AppError("Page not found.", 404);
}
export type ScreenData = Awaited<ReturnType<typeof loadScreen>>;
