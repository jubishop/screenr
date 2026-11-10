import { apiRoute } from "../../../server/api-route";
import { auth } from "../../../server/auth";
import { AppError } from "../../../server/db";
import { logFailure } from "../../../server/log";
import { liftSuspension, reviewReport } from "../../../server/reports";

// The owner's review actions on the website's review page
// (docs/data-and-access.md#content-reports): `{ "report": id, "action":
// "remove" | "suspend" | "dismiss" }`, and `{ "member": userId, "action":
// "lift" }` to lift a suspension. Only the owner's browser session reaches
// them; anyone else gets 404, as for a missing report.
const headers = { "Cache-Control": "private, no-store" };
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers });

async function review(request: Request) {
  try {
    if (
      request.headers.get("origin") !==
      new URL(process.env.BETTER_AUTH_URL!).origin
    )
      throw new AppError("Invalid request origin.", 403);
    const session = await auth().api.getSession({ headers: request.headers });
    if (!session) throw new AppError("Sign in to continue.", 401);
    let body: { report?: unknown; member?: unknown; action?: unknown };
    try {
      body = await request.json();
    } catch {
      throw new AppError("Invalid request.");
    }
    if (body?.action === "lift")
      await liftSuspension(session.user.id, body.member);
    else await reviewReport(session.user.id, body?.report, body?.action);
    return json({ ok: true });
  } catch (error) {
    if (error instanceof AppError)
      return json({ error: error.message }, error.status);
    logFailure("review action failed", { status: 500 }, error);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
}
export const POST = apiRoute(review);
