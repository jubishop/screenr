import { NextResponse } from "next/server";

// The invitation pickup's callback. The app's web authentication session
// receives it without loading it; a browser that follows the pickup's
// redirect itself goes on to the home page, so its token goes no further.
export function GET() {
  const response = NextResponse.redirect(
    new URL("/", process.env.BETTER_AUTH_URL!),
  );
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
