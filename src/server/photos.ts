import { createHash } from "node:crypto";
import { AppError, db } from "./db";
import { logFailure } from "./log";

// Profile photos (docs/data-and-access.md#profile-photos). PostgreSQL stores
// each photo, so the database backups cover them. The browser uploads a
// 512×512 JPEG; Google copies arrive in the format Google serves.
export const photoLimit = 200 * 1024;
type PhotoType = "image/jpeg" | "image/png" | "image/webp";
type Fetch = typeof fetch;

// Recognizes a photo by its leading bytes. The request's content type and
// Google's response headers are not trusted.
export function photoType(bytes: Uint8Array): PhotoType | null {
  const starts = (...values: number[]) =>
    values.every((value, index) => bytes[index] === value);
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return "image/png";
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP"
  )
    return "image/webp";
  return null;
}

// Avatar URLs name the photo's content, so a changed photo gets a new URL.
const photoVersion = (image: Buffer) =>
  createHash("sha256").update(image).digest("hex").slice(0, 16);

// A member's own choice replaces the current photo or a recorded removal.
// Photo writes touch no access rules, so they skip the domain write lock.
async function savePhoto(
  userId: string,
  image: Buffer,
  type: PhotoType,
  source: "upload" | "google",
) {
  const photo = photoVersion(image);
  await db.query(
    `INSERT INTO profile_photo(user_id,image,content_type,version,source)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT (user_id) DO UPDATE SET
      image=excluded.image,content_type=excluded.content_type,
      version=excluded.version,source=excluded.source,updated_at=now()`,
    [userId, image, type, photo, source],
  );
  return { photo };
}

export async function uploadPhoto(userId: string, upload: unknown) {
  if (!(upload instanceof Uint8Array) || !upload.length)
    throw new AppError("Choose a photo to upload.");
  if (upload.length > photoLimit)
    throw new AppError("Photos must be 200 KB or smaller.", 413);
  if (photoType(upload) !== "image/jpeg")
    throw new AppError("Photos must be JPEG images.", 415);
  return savePhoto(userId, Buffer.from(upload), "image/jpeg", "upload");
}

// The empty row records the removal, which stops automatic Google copies.
export async function removePhoto(userId: string) {
  await db.query(
    `INSERT INTO profile_photo(user_id) VALUES($1) ON CONFLICT (user_id) DO UPDATE
    SET image=NULL,content_type=NULL,version=NULL,source=NULL,updated_at=now()`,
    [userId],
  );
  return { photo: null };
}

// Google serves profile pictures from these hosts. Screenr fetches nothing
// else, so a changed user.image cannot direct a request to another server.
const googleHosts = /^lh[3-6]\.googleusercontent\.com$/;
const googleHost = (url: URL) =>
  url.protocol === "https:" &&
  googleHosts.test(url.hostname) &&
  !url.username &&
  !url.password &&
  !url.port;

// The 512-pixel square copy of a Google picture URL. Size options follow the
// last "=" (`/a/ID=s96-c`); older URLs carry them as a segment (`/s96-c/`).
export function googlePictureURL(value: unknown) {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!googleHost(url)) return null;
  const segments = url.pathname.split("/");
  const last = segments.length - 1;
  const options = segments[last].indexOf("=");
  const sized = segments.findIndex((segment) => /^s\d+(-c)?$/.test(segment));
  if (options >= 0)
    segments[last] = `${segments[last].slice(0, options)}=s512-c`;
  else if (sized > 0 && sized < last) segments[sized] = "s512-c";
  else segments[last] += "=s512-c";
  url.pathname = segments.join("/");
  url.search = "";
  url.hash = "";
  return url;
}

function pictureClaim(idToken: unknown): unknown {
  if (typeof idToken !== "string") return undefined;
  try {
    const payload = idToken.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
      ?.picture;
  } catch {
    return undefined;
  }
}

// A Google signup stores its picture as user.image. A Google account linked
// after an email-code signup leaves user.image empty, and its stored ID token
// carries the picture claim instead.
async function googlePicture(userId: string) {
  const { rows } = await db.query<{ image: string | null; id_token: unknown }>(
    `SELECT u.image,a."idToken" AS id_token FROM "user" u
    JOIN account a ON a."userId"=u.id AND a."providerId"='google'
    WHERE u.id=$1 ORDER BY a."updatedAt" DESC LIMIT 1`,
    [userId],
  );
  if (!rows[0]) return { google: false, url: null };
  return {
    google: true,
    url:
      googlePictureURL(rows[0].image) ??
      googlePictureURL(pictureClaim(rows[0].id_token)),
  };
}

class PictureError extends Error {
  constructor(
    readonly reason: string,
    readonly status?: number,
  ) {
    super(reason);
  }
}

// Fetches one picture, following at most three redirects within Google's
// hosts, and reads at most the photo limit.
async function fetchGooglePicture(
  start: URL,
  fetcher: Fetch,
  signal?: AbortSignal,
) {
  const deadline = AbortSignal.timeout(8000);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let url = start;
  for (let redirects = 0; ; redirects++) {
    const response = await fetcher(url, {
      redirect: "manual",
      signal: stop,
      cache: "no-store",
      headers: { Accept: "image/jpeg,image/png,image/webp" },
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      const next = new URL(location, url);
      if (redirects >= 3 || !googleHost(next))
        throw new PictureError("redirect", response.status);
      url = next;
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new PictureError("status", response.status);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > photoLimit) {
        await reader.cancel();
        throw new PictureError("too large");
      }
      chunks.push(value);
    }
    const image = Buffer.concat(chunks);
    const type = photoType(image);
    if (!type) throw new PictureError("not an image");
    return { image, type };
  }
}

function logCopyFailure(
  userId: string,
  trigger: "account" | "backfill" | "choice",
  error: unknown,
) {
  if (error instanceof PictureError)
    logFailure("google photo copy failed", {
      user: userId,
      trigger,
      reason: error.reason,
      status: error.status,
    });
  else
    logFailure(
      "google photo copy failed",
      { user: userId, trigger, reason: "error" },
      error,
    );
}

// Copies the Google picture for someone with no photo and no recorded
// removal: when a Google account is added, and in the one-time backfill.
// It never replaces a photo and never throws. A failure keeps the initial
// and is logged.
export async function copyGooglePhoto(
  userId: string,
  trigger: "account" | "backfill",
  fetcher: Fetch = fetch,
  signal?: AbortSignal,
): Promise<"copied" | "kept" | "no picture" | "failed"> {
  try {
    if (
      (await db.query("SELECT 1 FROM profile_photo WHERE user_id=$1", [userId]))
        .rowCount
    )
      return "kept";
    const { url } = await googlePicture(userId);
    if (!url) return "no picture";
    const { image, type } = await fetchGooglePicture(url, fetcher, signal);
    const inserted = await db.query(
      `INSERT INTO profile_photo(user_id,image,content_type,version,source)
      VALUES($1,$2,$3,$4,'google') ON CONFLICT (user_id) DO NOTHING`,
      [userId, image, type, photoVersion(image)],
    );
    return inserted.rowCount ? "copied" : "kept";
  } catch (error) {
    // A stopping worker abandons its copy; the next start retries it.
    if (!signal?.aborted) logCopyFailure(userId, trigger, error);
    return "failed";
  }
}

// "Use my Google photo" replaces the current photo or a removal.
export async function chooseGooglePhoto(
  userId: string,
  fetcher: Fetch = fetch,
) {
  const { google, url } = await googlePicture(userId);
  if (!google)
    throw new AppError("Connect Google on Account to use your Google photo.");
  if (!url) throw new AppError("Your Google account has no photo to use.");
  let picture;
  try {
    picture = await fetchGooglePicture(url, fetcher);
  } catch (error) {
    logCopyFailure(userId, "choice", error);
    throw new AppError(
      "Your Google photo could not be copied. Please try again.",
      502,
    );
  }
  return savePhoto(userId, picture.image, picture.type, "google");
}

// Copies the Google picture of everyone with Google sign-in who has neither
// a photo nor a recorded removal, one person at a time.
async function backfill(fetcher: Fetch, signal?: AbortSignal) {
  const { rows } = await db.query<{ id: string }>(
    `SELECT DISTINCT a."userId" AS id FROM account a
    WHERE a."providerId"='google'
      AND NOT EXISTS (SELECT 1 FROM profile_photo p WHERE p.user_id=a."userId")
    ORDER BY id`,
  );
  const counts = { copied: 0, kept: 0, "no picture": 0, failed: 0 };
  for (const { id } of rows) {
    if (signal?.aborted) return { counts, complete: false };
    const result = await copyGooglePhoto(id, "backfill", fetcher, signal);
    // A copy that a stopping worker abandoned is not a failure.
    if (result === "failed" && signal?.aborted)
      return { counts, complete: false };
    counts[result]++;
  }
  return { counts, complete: true };
}
export async function backfillGooglePhotos(
  fetcher: Fetch = fetch,
  signal?: AbortSignal,
) {
  return (await backfill(fetcher, signal)).counts;
}

// screenr-worker runs the backfill once, when the first release with photos
// starts. The marker is written after a complete pass, so a stopped pass runs
// again on the next start. Deleting the marker and restarting the worker
// retries failures; copies never replace a photo or a removal.
export const photoBackfill = "google-photos";
export async function runPhotoBackfill(
  fetcher: Fetch = fetch,
  signal?: AbortSignal,
) {
  try {
    if (
      (
        await db.query("SELECT 1 FROM screenr_backfill WHERE name=$1", [
          photoBackfill,
        ])
      ).rowCount
    )
      return null;
    const { counts, complete } = await backfill(fetcher, signal);
    if (!complete) return null;
    await db.query(
      "INSERT INTO screenr_backfill(name) VALUES($1) ON CONFLICT DO NOTHING",
      [photoBackfill],
    );
    console.log(
      JSON.stringify({ event: "google photo backfill finished", ...counts }),
    );
    return counts;
  } catch (error) {
    logFailure("google photo backfill failed", {}, error);
    return null;
  }
}

// The photo for an avatar URL, when the viewer may see that profile: their
// own photo, including before setup, or the photo of a member whose profile
// the viewer, also a member, can open. Blocking hides it in both directions.
export async function viewablePhoto(
  viewer: string,
  owner: string,
  version: string,
) {
  if (!/^[0-9a-f]{16}$/.test(version) || owner.length > 255) return null;
  const { rows } = await db.query<{ image: Buffer; content_type: string }>(
    `SELECT image,content_type FROM profile_photo WHERE user_id=$2 AND version=$3
    AND ($1=$2 OR (EXISTS (SELECT 1 FROM profile WHERE user_id=$1)
      AND EXISTS (SELECT 1 FROM profile WHERE user_id=$2)
      AND NOT screenr_blocked($1,$2)))`,
    [viewer, owner, version],
  );
  return rows[0] ?? null;
}

// The setup page's photo state, before the profile exists.
export async function photoSetup(userId: string) {
  const { rows } = await db.query<{ photo: string | null; google: boolean }>(
    `SELECT screenr_photo($1) AS photo,EXISTS (SELECT 1 FROM account
      WHERE "userId"=$1 AND "providerId"='google') AS google`,
    [userId],
  );
  return rows[0];
}
