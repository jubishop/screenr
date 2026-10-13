import { requestSession } from "../../../../../server/auth";
import { viewablePhoto } from "../../../../../server/photos";

// Serves a profile photo to signed-in people who may see that profile, by
// cookie or by a native client's bearer token. The URL names the photo's
// version, so a client may keep its own copy for a day. `private` keeps
// shared caches from storing it, and `Vary` stops another person signed in
// to the same browser or app from reusing that copy.
const vary = "Cookie, Authorization";
const unavailable = (status: number) =>
  new Response(null, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: vary },
  });
export async function GET(
  request: Request,
  { params }: { params: Promise<{ user: string; version: string }> },
) {
  const { user, version } = await params;
  const session = await requestSession(request.headers);
  if (!session) return unavailable(401);
  const photo = await viewablePhoto(session.user.id, user, version);
  if (!photo) return unavailable(404);
  const headers = {
    "Cache-Control": "private, max-age=86400",
    Vary: vary,
    ETag: `"${version}"`,
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (request.headers.get("if-none-match") === headers.ETag)
    return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(photo.image), {
    headers: { ...headers, "Content-Type": photo.content_type },
  });
}
