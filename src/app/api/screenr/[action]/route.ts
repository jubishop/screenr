import { auth } from "../../../../server/auth";
import { findAction } from "../../../../server/actions";
import { AppError } from "../../../../server/db";
import { logFailure } from "../../../../server/log";
import { member } from "../../../../server/profiles";
import { recordActiveDay } from "../../../../server/usage";

const json = (data: unknown, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
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
    const result =
      action.method === "GET"
        ? await action.respond(new URL(request.url).searchParams, {
            ...context,
            user,
          })
        : await action.respond(await body(request), { ...context, user });
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
