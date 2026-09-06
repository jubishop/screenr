import { NextResponse } from "next/server";
import { activeInvitation, invitationHash } from "../../../server/invitations";
import { auth } from "../../../server/auth";
import { db } from "../../../server/db";
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
  const response = NextResponse.redirect(
    new URL(session ? "/setup" : "/login", url),
  );
  response.cookies.set("screenr-invite", token, {
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
