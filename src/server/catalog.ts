import { AppError, db } from "./db";
import { watchSections } from "./watch-sources";
import {
  watchCategories,
  type Title,
  type Trailer,
  type WatchAvailability,
} from "../shared";

function isolatedBrowserTest() {
  try {
    const database = new URL(process.env.DATABASE_URL ?? "");
    return (
      process.env.SCREENR_BROWSER_TEST === "1" &&
      /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.BETTER_AUTH_URL ?? "") &&
      ["postgres:", "postgresql:"].includes(database.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) &&
      database.search === "" &&
      /^\/screenr_browser_[a-z0-9_]+_test$/.test(database.pathname) &&
      database.pathname.length <= 64
    );
  } catch {
    return false;
  }
}

function catalogConfig() {
  const base =
    process.env.SCREENR_TEST_TMDB_URL ?? "https://api.themoviedb.org/3";
  if (
    process.env.SCREENR_TEST_TMDB_URL &&
    ((process.env.NODE_ENV === "production" && !isolatedBrowserTest()) ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
  ) {
    throw new Error(
      "The catalog test server requires loopback and, in production mode, an isolated browser-test environment.",
    );
  }
  if (!process.env.TMDB_READ_TOKEN && !process.env.SCREENR_TEST_TMDB_URL)
    throw new AppError("The movie catalog is not configured yet.", 503);
  return { base, token: process.env.TMDB_READ_TOKEN ?? "test" };
}
async function fetchCatalog(path: string, timeout = 8000) {
  const { base, token } = catalogConfig();
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeout),
      cache: "no-store",
    });
    if (response.status === 404) throw new AppError("Title not found.", 404);
    if (!response.ok) throw new Error("Catalog request failed");
    return await response.json();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "The movie catalog is temporarily unavailable. Please try again.",
      502,
    );
  }
}
function parseTitle(raw: Record<string, unknown>, kind: "movie" | "tv"): Title {
  const name = kind === "movie" ? raw.title : raw.name;
  if (
    !Number.isSafeInteger(raw.id) ||
    Number(raw.id) <= 0 ||
    typeof name !== "string" ||
    !name
  )
    throw new AppError("The catalog returned an invalid title.", 502);
  return {
    id: `${kind}:${raw.id}`,
    kind,
    tmdb_id: Number(raw.id),
    name,
    overview: typeof raw.overview === "string" ? raw.overview : "",
    poster_path:
      typeof raw.poster_path === "string" &&
      /^\/[a-zA-Z0-9._-]+$/.test(raw.poster_path)
        ? raw.poster_path
        : null,
    release_date:
      typeof (kind === "movie" ? raw.release_date : raw.first_air_date) ===
      "string"
        ? String(kind === "movie" ? raw.release_date : raw.first_air_date)
        : "",
  };
}
export async function searchTitles(query: string): Promise<Title[]> {
  if (query.trim().length < 2) return [];
  if (query.length > 120) throw new AppError("Use a shorter search.");
  const data = await fetchCatalog(
    `/search/multi?query=${encodeURIComponent(query)}&include_adult=false`,
  );
  if (!Array.isArray(data.results))
    throw new AppError("The catalog returned invalid search results.", 502);
  return data.results
    .filter(
      (r: Record<string, unknown>) =>
        r.media_type === "movie" || r.media_type === "tv",
    )
    .map((r: Record<string, unknown>) =>
      parseTitle(r, r.media_type as "movie" | "tv"),
    );
}
export async function getTitle(id: string): Promise<Title> {
  if (!/^(movie|tv):[1-9][0-9]*$/.test(id))
    throw new AppError("Title not found.", 404);
  const cached = (
    await db.query(
      "SELECT * FROM title WHERE id=$1 AND fetched_at>now()-interval '1 day'",
      [id],
    )
  ).rows[0];
  if (cached) return cached;
  const [kind, tmdbId] = id.split(":");
  const title = parseTitle(
    await fetchCatalog(`/${kind}/${tmdbId}`),
    kind as "movie" | "tv",
  );
  await db.query(
    `INSERT INTO title(id,kind,tmdb_id,name,overview,poster_path,release_date) VALUES($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,overview=excluded.overview,poster_path=excluded.poster_path,
    release_date=excluded.release_date,fetched_at=now()`,
    [
      title.id,
      title.kind,
      title.tmdb_id,
      title.name,
      title.overview,
      title.poster_path,
      title.release_date,
    ],
  );
  return title;
}

function selectTrailer(data: unknown): Trailer | null {
  if (
    !data ||
    typeof data !== "object" ||
    !("results" in data) ||
    !Array.isArray(data.results)
  )
    throw new Error("Invalid trailer metadata");
  const trailers = data.results.filter(
    (video) =>
      video &&
      video.site === "YouTube" &&
      video.type === "Trailer" &&
      typeof video.key === "string" &&
      /^[a-zA-Z0-9_-]{11}$/.test(video.key) &&
      typeof video.name === "string" &&
      video.name.trim(),
  );
  const selected =
    trailers.find((video) => video.official === true) ?? trailers[0];
  return selected ? { key: selected.key, name: selected.name.trim() } : null;
}

// Optional public metadata has its own cache and timeout. A failed provider
// request must not break a title page or repeat on every three-second poll.
export async function getTitleTrailer(id: string): Promise<Trailer | null> {
  if (!/^(movie|tv):[1-9][0-9]*$/.test(id)) return null;
  try {
    const cached = (
      await db.query(
        "SELECT trailer FROM title_trailer WHERE title_id=$1 AND expires_at>now()",
        [id],
      )
    ).rows[0];
    if (cached) return cached.trailer;
    let trailer: Trailer | null = null;
    let lifetime = 86400;
    try {
      trailer = selectTrailer(
        await fetchCatalog(`/${id.replace(":", "/")}/videos`, 2000),
      );
    } catch {
      lifetime = 300;
    }
    await db.query(
      `INSERT INTO title_trailer(title_id,trailer,expires_at)
       VALUES($1,$2,now()+$3*interval '1 second')
       ON CONFLICT(title_id) DO UPDATE SET trailer=excluded.trailer,expires_at=excluded.expires_at`,
      [id, trailer, lifetime],
    );
    return trailer;
  } catch {
    return null;
  }
}

type AvailabilityData = Pick<WatchAvailability, "link" | "providers">;
type CachedAvailability = {
  availability: AvailabilityData | null;
  fetched_at: Date | null;
  refresh_after: Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAvailability(data: unknown, id: string): AvailabilityData {
  const [kind, tmdbId] = id.split(":");
  if (!isRecord(data) || data.id !== Number(tmdbId) || !isRecord(data.results))
    throw new Error("Invalid watch-provider response");
  const us = data.results.US;
  const result: AvailabilityData = { link: null, providers: {} };
  if (us === undefined) return result;
  if (!isRecord(us)) throw new Error("Invalid US watch providers");
  if (us.link !== undefined) {
    if (typeof us.link !== "string") throw new Error("Invalid watch link");
    const link = new URL(us.link);
    if (
      link.origin !== "https://www.themoviedb.org" ||
      link.username ||
      link.password ||
      !new RegExp(`^/${kind}/${tmdbId}(?:-[^/]+)?/watch$`).test(link.pathname)
    )
      throw new Error("Invalid watch link");
    result.link = link.href;
  }
  for (const category of watchCategories) {
    const items = us[category];
    if (items === undefined) continue;
    if (!Array.isArray(items)) throw new Error("Invalid viewing category");
    const providers = items.map((item: unknown) => {
      if (
        !isRecord(item) ||
        !Number.isSafeInteger(item.provider_id) ||
        Number(item.provider_id) <= 0 ||
        typeof item.provider_name !== "string" ||
        !item.provider_name.trim()
      )
        throw new Error("Invalid watch provider");
      return {
        provider_id: Number(item.provider_id),
        provider_name: item.provider_name.trim(),
        logo_path:
          typeof item.logo_path === "string" &&
          /^\/[a-zA-Z0-9._-]+$/.test(item.logo_path)
            ? item.logo_path
            : null,
      };
    });
    if (providers.length) result.providers[category] = providers;
  }
  return result;
}

function availabilityResult(cached?: CachedAvailability): WatchAvailability {
  const providers = cached?.availability?.providers ?? {};
  return {
    country: "US",
    status: !cached?.fetched_at
      ? "unavailable"
      : Date.now() - cached.fetched_at.getTime() < 86_400_000
        ? "ok"
        : "stale",
    checked_at: cached?.fetched_at?.toISOString() ?? null,
    link: cached?.availability?.link ?? null,
    providers,
    sections: watchSections(providers),
  };
}

// Fetch only optional public metadata here. A failed refresh must neither
// erase the last success nor be retried on every title-screen poll.
export async function getTitleAvailability(
  id: string,
  refreshBefore = Infinity,
): Promise<WatchAvailability> {
  if (!/^(movie|tv):[1-9][0-9]*$/.test(id)) return availabilityResult();
  let cached: CachedAvailability | undefined;
  try {
    cached = (
      await db.query<CachedAvailability>(
        "SELECT availability,fetched_at,refresh_after FROM title_availability WHERE title_id=$1 AND country='US'",
        [id],
      )
    ).rows[0];
    if (
      Date.now() >= refreshBefore ||
      (cached && cached.refresh_after.getTime() > Date.now())
    )
      return availabilityResult(cached);
    let availability: AvailabilityData;
    try {
      availability = parseAvailability(
        await fetchCatalog(`/${id.replace(":", "/")}/watch/providers`, 2000),
        id,
      );
    } catch {
      const failed = (
        await db.query<CachedAvailability>(
          `INSERT INTO title_availability(title_id,country,refresh_after)
         VALUES($1,'US',now()+interval '5 minutes')
         ON CONFLICT(title_id,country) DO UPDATE
         SET refresh_after=greatest(title_availability.refresh_after,excluded.refresh_after)
         RETURNING availability,fetched_at,refresh_after`,
          [id],
        )
      ).rows[0];
      return availabilityResult(failed);
    }
    const saved = (
      await db.query<CachedAvailability>(
        `INSERT INTO title_availability(title_id,country,availability,fetched_at,refresh_after)
       VALUES($1,'US',$2,now(),now()+interval '1 day')
       ON CONFLICT(title_id,country) DO UPDATE SET availability=excluded.availability,
       fetched_at=excluded.fetched_at,refresh_after=excluded.refresh_after
       RETURNING availability,fetched_at,refresh_after`,
        [id, availability],
      )
    ).rows[0];
    return availabilityResult(saved);
  } catch {
    return availabilityResult(cached);
  }
}
