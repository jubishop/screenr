import { NextResponse, type NextRequest } from "next/server";
import {
  invitationCookie,
  invitationFormat,
  pickupCallbackPath,
} from "../../../server/invitation-pickup";

// The iPhone app's web authentication session opens this page to pick up the
// invitation that /join saved in Safari before it sent the person to install
// the app (docs/data-and-access.md#invitation-pickup). It redirects to the
// callback with the token, or without one when Safari saved none. The session
// hands the callback to the app without loading it, and only an app this
// domain lists for its web credentials can receive it. The cookie goes, so the
// invitation is picked up once.
export function GET(request: NextRequest) {
  const url = new URL(process.env.BETTER_AUTH_URL!);
  const callback = new URL(pickupCallbackPath, url);
  const saved = request.cookies.get(invitationCookie)?.value;
  if (saved && invitationFormat.test(saved))
    callback.searchParams.set("token", saved);
  const response = NextResponse.redirect(callback);
  if (saved !== undefined)
    response.cookies.set(invitationCookie, "", {
      httpOnly: true,
      secure: url.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
