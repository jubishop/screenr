import { conversations, people, profileFor, conversationURL } from "./social";
import { getTitle, getTitleTrailer, getTitleAvailability } from "./catalog";
import { listInvitations } from "./invitations";
import { AppError, db } from "./db";
import { watchTogether } from "./watch-together";
import { titleSuggestions } from "./title-suggestions";

export async function loadScreen(userId: string, requestedPath: string) {
  const url = new URL(requestedPath, "http://screenr.local");
  const path = url.pathname;
  if (path === "/")
    return {
      kind: "feed" as const,
      conversations: await conversations(userId),
    };
  if (path === "/search")
    return {
      kind: "search" as const,
      suggestions: await titleSuggestions(userId),
    };
  if (path === "/people")
    return { kind: "people" as const, ...(await people(userId)) };
  if (path === "/watch-together") {
    const usernames = url.searchParams.getAll("with");
    if (usernames.length !== 1 || !usernames[0])
      throw new AppError("Choose one friend from their profile.");
    return {
      kind: "watch-together" as const,
      ...(await watchTogether(userId, usernames)),
    };
  }
  if (path === "/invites")
    return {
      kind: "invites" as const,
      invitations: await listInvitations(userId),
    };
  if (path === "/account")
    return {
      kind: "account" as const,
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
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "titles" && parts.length === 3) {
    const id = `${parts[1]}:${parts[2]}`;
    const [title, threads] = await Promise.all([
      getTitle(id),
      conversations(userId, { title: id }),
    ]);
    const [trailer, availability] = await Promise.all([
      getTitleTrailer(id),
      getTitleAvailability(id),
    ]);
    return {
      kind: "title" as const,
      title,
      trailer,
      availability,
      conversations: threads,
      target: (() => {
        const item = threads.find((c) => c.id === url.searchParams.get("item"));
        if (!item) return null;
        const reply = item.comments.find(
          (c) => c.id === url.searchParams.get("reply") && !c.unavailable,
        );
        return { item: item.id, reply: reply?.id };
      })(),
      targetUnavailable:
        !!url.searchParams.get("item") &&
        !threads.some(
          (c) =>
            c.id === url.searchParams.get("item") &&
            (!url.searchParams.get("reply") ||
              c.comments.some(
                (r) => r.id === url.searchParams.get("reply") && !r.unavailable,
              )),
        ),
    };
  }
  if (parts[0] === "people" && parts.length === 2) {
    const profile = await profileFor(userId, parts[1]);
    return {
      kind: "profile" as const,
      profile,
      conversations: profile.can_read
        ? await conversations(userId, { owner: profile.user_id })
        : [],
    };
  }
  if (parts[0] === "conversations" && parts.length === 2)
    return {
      kind: "redirect" as const,
      url: await conversationURL(
        userId,
        parts[1],
        url.searchParams.get("reply") ?? undefined,
      ),
    };
  throw new AppError("Page not found.", 404);
}
export type ScreenData = Awaited<ReturnType<typeof loadScreen>>;
