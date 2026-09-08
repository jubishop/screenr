import { auth, tokenFromCookie } from "../../../../server/auth";
import { AppError } from "../../../../server/db";
import {
  member,
  addComment,
  createTitleComment,
  removeComment,
  setReaction,
  changeRelationship,
  updateTitleActivity,
  updateDisplayName,
  updateProfile,
} from "../../../../server/social";
import {
  completeSignup,
  createInvitation,
  revokeInvitation,
} from "../../../../server/invitations";
import { getTitle, searchTitles } from "../../../../server/catalog";
import { loadScreen } from "../../../../server/screens";

const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
async function body(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("A request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16_000) {
      await reader.cancel();
      throw new AppError("Request too large.", 413);
    }
    chunks.push(value);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Expected an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError("Invalid request.");
  }
}
async function handle(
  request: Request,
  { params }: { params: Promise<{ action: string }> },
) {
  const { action } = await params;
  try {
    if (
      request.method === "POST" &&
      request.headers.get("origin") !==
        new URL(process.env.BETTER_AUTH_URL!).origin
    )
      throw new AppError("Invalid request origin.", 403);
    const session = await auth().api.getSession({ headers: request.headers });
    if (!session) throw new AppError("Sign in to continue.", 401);
    const userId = session.user.id;
    if (action === "setup" && request.method === "POST") {
      const data = await body(request);
      await completeSignup(
        userId,
        data.name,
        data.username,
        tokenFromCookie(request.headers),
      );
      return json({ ok: true });
    }
    const user = await member(userId);
    if (request.method === "GET") {
      const url = new URL(request.url);
      if (action === "screen")
        return json({
          ...(await loadScreen(userId, url.searchParams.get("path") ?? "/")),
          user,
        });
      if (action === "search")
        return json(await searchTitles(url.searchParams.get("q") ?? ""));
    } else {
      const data = await body(request);
      if (action === "display-name")
        return json(await updateDisplayName(userId, data.name));
      if (action === "profile")
        return json(await updateProfile(userId, data.name, data.username));
      if (action === "invite")
        return json(await createInvitation(userId, data.limit ?? 1));
      if (action === "revoke-invite")
        await revokeInvitation(userId, String(data.id));
      else if (action === "relationship")
        await changeRelationship(
          userId,
          String(data.target),
          String(data.action),
        );
      else if (action === "activity") {
        const title = await getTitle(String(data.title));
        return json({
          id: await updateTitleActivity(
            userId,
            title.id,
            String(data.field),
            data.value,
          ),
        });
      } else if (action === "title-comment") {
        const title = await getTitle(String(data.title));
        return json({
          id: await createTitleComment(
            userId,
            title.id,
            data.body,
            data.spoiler,
          ),
        });
      } else if (action === "comment")
        return json({
          id: await addComment(
            userId,
            String(data.conversation),
            data.body,
            data.spoiler,
            data.replyTo,
          ),
        });
      else if (action === "remove-comment")
        await removeComment(userId, String(data.id));
      else if (action === "reaction")
        await setReaction(userId, String(data.item), data.reply, data.kind);
      else throw new AppError("Action not found.", 404);
      return json({ ok: true });
    }
    throw new AppError("Action not found.", 404);
  } catch (error) {
    if (error instanceof AppError)
      return json({ error: error.message }, error.status);
    console.error("Screenr request failed", {
      action,
      error: error instanceof Error ? error.name : "unknown",
    });
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export const GET = handle;
export const POST = handle;
