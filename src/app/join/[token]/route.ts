import { NextResponse } from "next/server";
import { activeInvitation, invitationHash } from "../../../server/invitations";
import { auth } from "../../../server/auth";
import { db } from "../../../server/db";
import {
  invitationCookie,
  iphoneBrowser,
  iphoneInstallURL,
} from "../../../server/invitation-pickup";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const url = new URL(process.env.BETTER_AUTH_URL!);
  const session = await auth().api.getSession({ headers: request.headers });
  if (
    session &&
    (
      await db.query("SELECT 1 FROM profile WHERE user_id=$1", [
        session.user.id,
      ])
    ).rowCount
  )
    return NextResponse.redirect(new URL("/", url));
  const hash = invitationHash(token);
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token) || !(await activeInvitation(hash)))
    return NextResponse.redirect(new URL("/login?invitation=unavailable", url));
  // Setup validates and consumes this invitation in its signup transaction,
  // whether the pending account follows the link before or after signing in.
  // An iPhone without the app, since the app opens this link when installed,
  // goes to install it instead and picks the invitation up from this cookie:
  // docs/ios-app.md#invitation-links-install-the-app-on-iphone--2026-11-07
  const install = session ? undefined : iphoneInstallURL();
  const response = NextResponse.redirect(
    install && iphoneBrowser(request.headers)
      ? install
      : new URL(session ? "/setup" : "/login", url),
  );
  response.cookies.set(invitationCookie, token, {
    httpOnly: true,
    secure: url.protocol === "https:",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 86400,
  });
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
