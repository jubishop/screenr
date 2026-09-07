import { conversations, people, profileFor, thread } from "./social";
import { getTitle, getTitleTrailer } from "./catalog";
import { listInvitations } from "./invitations";
import { AppError, db } from "./db";

export async function loadScreen(userId: string, path: string) {
  if (path === "/")
    return {
      kind: "feed" as const,
      conversations: await conversations(userId),
    };
  if (path === "/search") return { kind: "search" as const };
  if (path === "/people")
    return { kind: "people" as const, ...(await people(userId)) };
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
    return {
      kind: "title" as const,
      title,
      trailer: await getTitleTrailer(id),
      conversations: threads,
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
    return { kind: "thread" as const, ...(await thread(userId, parts[1])) };
  throw new AppError("Page not found.", 404);
}
export type ScreenData = Awaited<ReturnType<typeof loadScreen>>;
