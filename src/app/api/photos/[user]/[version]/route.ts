import { auth } from "../../../../../server/auth";
import { viewablePhoto } from "../../../../../server/photos";

// Serves a profile photo to signed-in people who may see that profile. The
// URL names the photo's version, so a browser may keep its own copy for a
// day. `private` keeps shared caches from storing it, and `Vary: Cookie`
// stops another person signed in to the same browser from reusing that copy.
const unavailable = (status: number) =>
  new Response(null, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
export async function GET(
  request: Request,
  { params }: { params: Promise<{ user: string; version: string }> },
) {
  const { user, version } = await params;
  const session = await auth().api.getSession({ headers: request.headers });
  if (!session) return unavailable(401);
  const photo = await viewablePhoto(session.user.id, user, version);
  if (!photo) return unavailable(404);
  const headers = {
    "Cache-Control": "private, max-age=86400",
    Vary: "Cookie",
    ETag: `"${version}"`,
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (request.headers.get("if-none-match") === headers.ETag)
    return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(photo.image), {
    headers: { ...headers, "Content-Type": photo.content_type },
  });
}
