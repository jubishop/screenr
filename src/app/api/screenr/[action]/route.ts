import { auth } from "../../../../server/auth";
import { findAction } from "../../../../server/actions";
import { AppError } from "../../../../server/db";
import { logFailure } from "../../../../server/log";
import { member } from "../../../../server/profiles";
import { readVersion } from "../../../../server/screens";
import { recordActiveDay } from "../../../../server/usage";

// Responses depend on the session, and no cache may store them.
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers });
// A successful read carries its version. A request whose If-None-Match lists
// it, compared weakly, gets 304 without a body.
function versioned(request: Request, data: unknown) {
  const body = JSON.stringify(data);
  const version = readVersion(body);
  const held = request.headers.get("If-None-Match")?.split(",") ?? [];
  if (held.some((tag) => tag.trim().replace(/^W\//, "") === version.slice(2)))
    return new Response(null, {
      status: 304,
      headers: { ...headers, ETag: version },
    });
  return new Response(body, {
    headers: { ...headers, ETag: version, "Content-Type": "application/json" },
  });
}
async function read(request: Request, limit: number) {
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("A request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new AppError("Request too large.", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function body(request: Request) {
  const bytes = await read(request, 16_000);
  try {
    const parsed = JSON.parse(bytes.toString());
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
  const { action: name } = await params;
  const action = findAction(name, request.method);
  try {
    if (
      request.method === "POST" &&
      request.headers.get("origin") !==
        new URL(process.env.BETTER_AUTH_URL!).origin
    )
      throw new AppError("Invalid request origin.", 403);
    const session = await auth().api.getSession({ headers: request.headers });
    if (!session) throw new AppError("Sign in to continue.", 401);
    const context = { userId: session.user.id, headers: request.headers };
    if (action && !action.profile) {
      if (action.usage) await recordActiveDay(context.userId);
      const input = action.upload
        ? { upload: await read(request, action.upload) }
        : await body(request);
      return json((await action.respond(input, context)) ?? { ok: true });
    }
    const user = await member(context.userId);
    if (!action) throw new AppError("Action not found.", 404);
    if (action.usage) await recordActiveDay(context.userId);
    if (action.method === "GET") {
      const query = new URL(request.url).searchParams;
      const result = await action.respond(query, { ...context, user });
      return versioned(request, result ?? { ok: true });
    }
    const result = await action.respond(await body(request), {
      ...context,
      user,
    });
    return json(result ?? { ok: true });
  } catch (error) {
    if (error instanceof AppError)
      return json({ error: error.message }, error.status);
    // The path segment is client input; only a known action is named.
    logFailure(
      "request failed",
      { action: action && name, method: request.method, status: 500 },
      error,
    );
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export const GET = handle;
export const POST = handle;
