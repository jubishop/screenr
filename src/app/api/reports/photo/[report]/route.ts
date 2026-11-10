import { apiRoute } from "../../../../../server/api-route";
import { auth } from "../../../../../server/auth";
import { isOwner, reportPhoto } from "../../../../../server/reports";

// The photo a profile report kept, for the owner's review page. Anyone else,
// and a report without a photo, gets 404.
const headers = {
  "Cache-Control": "private, no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
};
async function servePhoto(
  request: Request,
  { params }: { params: Promise<{ report: string }> },
) {
  const session = await auth().api.getSession({ headers: request.headers });
  const photo =
    session && (await isOwner(session.user.id))
      ? await reportPhoto((await params).report)
      : null;
  if (!photo) return new Response(null, { status: 404, headers });
  return new Response(new Uint8Array(photo.photo), {
    headers: { ...headers, "Content-Type": photo.photo_type },
  });
}
export const GET = apiRoute(servePhoto);
