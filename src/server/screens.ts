import { profileFor } from "./profiles";
import { people } from "./relationships";
import { conversations, conversationURL, friendActivity } from "./feed";
import { getTitle, getTitleTrailer, getTitleAvailability } from "./catalog";
import { listInvitations } from "./invitations";
import { AppError, db } from "./db";
import { watchTogether } from "./watch-together";
import { titleSuggestions } from "./title-suggestions";
import { savedServices, streamingServices } from "./streaming-services";
import { withViewingOptions } from "./title-viewing";
import { activityEmail, unreadNotifications } from "./notifications";
import { logFailure } from "./log";
import { watchStatus } from "./title-actions";
import { parseMemberRoute, type MemberRoute } from "../member-routes";

export async function loadScreen(userId: string, requestedPath: string) {
  const [content, unread] = await Promise.all([
    loadContent(userId, parseMemberRoute(requestedPath)),
    unreadNotifications(userId),
  ]);
  return content.kind === "redirect"
    ? content
    : { ...content, unreadNotifications: unread };
}

// The member page loads its first screen on the server. A failure shows its
// message in the page instead of an error page. Unexpected failures are
// logged with the route kind, not the path, which can name people or
// search terms.
export async function initialScreen(userId: string, requestedPath: string) {
  try {
    return { data: await loadScreen(userId, requestedPath), error: "" };
  } catch (error) {
    if (error instanceof AppError) return { data: null, error: error.message };
    logFailure(
      "page failed",
      { route: parseMemberRoute(requestedPath).kind },
      error,
    );
    return {
      data: null,
      error: "This page could not load. Please try again.",
    };
  }
}

async function loadContent(userId: string, route: MemberRoute) {
  if (route.kind === "feed")
    return {
      kind: "feed" as const,
      conversations: await conversations(userId),
    };
  if (route.kind === "search")
    return {
      kind: "search" as const,
      suggestions: await withViewingOptions(await titleSuggestions(userId)),
      serviceIds: await savedServices(userId),
    };
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
    const { id, item, reply } = route;
    // Catalog requests run together to fit the client's refresh deadline.
    const stored = getTitle(id);
    const [title, threads, trailer, availability, watch] = await Promise.all([
      stored,
      conversations(userId, { title: id }),
      getTitleTrailer(id, stored),
      getTitleAvailability(id, Infinity, stored),
      watchStatus(userId, id),
    ]);
    return {
      kind: "title" as const,
      title,
      trailer,
      availability,
      watch,
      conversations: threads,
      friends: friendActivity(userId, threads),
      target: (() => {
        const targeted = threads.find((c) => c.id === item);
        if (!targeted) return null;
        const targetReply = targeted.comments.find(
          (c) => c.id === reply && !c.unavailable,
        );
        return { item: targeted.id, reply: targetReply?.id };
      })(),
      targetUnavailable:
        !!item &&
        !threads.some(
          (c) =>
            c.id === item &&
            (!reply ||
              c.comments.some((r) => r.id === reply && !r.unavailable)),
        ),
    };
  }
  if (route.kind === "profile") {
    const profile = await profileFor(userId, route.username);
    return {
      kind: "profile" as const,
      profile,
      conversations: profile.can_read
        ? await conversations(userId, { owner: profile.user_id })
        : [],
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
