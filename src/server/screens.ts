import { createHash } from "node:crypto";
import { profileFor } from "./profiles";
import { people } from "./relationships";
import {
  conversations,
  conversationURL,
  friendActivity,
  linkTarget,
} from "./feed";
import { getTitle, getTitleTrailer, getTitleAvailability } from "./catalog";
import { listInvitations } from "./invitations";
import { AppError, db } from "./db";
import { watchTogether } from "./watch-together";
import { titleSuggestions } from "./title-suggestions";
import { friendsRecommend } from "./friends-recommend";
import { savedServices, streamingServices } from "./streaming-services";
import { withViewingOptions } from "./title-viewing";
import { activityEmail, unreadNotifications } from "./notifications";
import { pushSettings } from "./push";
import { logFailure } from "./log";
import { watchStatus } from "./title-actions";
import { topTen, topTenRanks } from "./top-ten";
import { parseMemberRoute, type MemberRoute } from "../member-routes";
import type { Person, Title } from "../shared";

export async function loadScreen(userId: string, requestedPath: string) {
  const [content, unread] = await Promise.all([
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
// search terms.
export async function initialScreen(userId: string, requestedPath: string) {
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
}

async function loadContent(userId: string, route: MemberRoute) {
  if (route.kind === "feed") {
    // Links to posts without a title open them here.
    const threads = await conversations(userId);
    return {
      kind: "feed" as const,
      conversations: threads,
      ...linkTarget(threads, route),
    };
  }
  if (route.kind === "search") {
    // Both Find a title tabs load together, so switching tabs needs no new
    // read, and one availability read covers titles on either list.
    const [suggestions, recommendations, serviceIds] = await Promise.all([
      titleSuggestions(userId),
      friendsRecommend(userId),
      savedServices(userId),
    ]);
    const viewing = new Map(
      (await withViewingOptions([...suggestions, ...recommendations])).map(
        (title) => [title.id, title.viewing],
      ),
    );
    const withViewing = <T extends Title>(titles: T[]) =>
      titles.map((title) => ({ ...title, viewing: viewing.get(title.id)! }));
    return {
      kind: "search" as const,
      suggestions: withViewing(suggestions),
      recommendations: withViewing(recommendations),
      serviceIds,
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
      ...(await watchTogether(userId, usernames)),
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
    };
  if (route.kind === "title") {
    const { id } = route;
    // Catalog requests run together to fit the client's refresh deadline.
    const stored = getTitle(id);
    const [title, threads, trailer, availability, watch, own, ranks] =
      await Promise.all([
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
    // The top 10 is visible to every member who can see the profile; the
    // entries and discussions behind it stay friends-only.
    const [list, entries] = await Promise.all([
      topTen(profile.user_id),
      profile.can_read
        ? conversations(userId, { owner: profile.user_id })
        : Promise.resolve([]),
    ]);
    return {
      kind: "profile" as const,
      profile,
      topTen: list,
      conversations: entries,
    };
  }
  if (route.kind === "conversation")
    return {
      kind: "redirect" as const,
      url: await conversationURL(userId, route.id, route.reply),
    };
  throw new AppError("Page not found.", 404);
}
export type ScreenData = Awaited<ReturnType<typeof loadScreen>>;
