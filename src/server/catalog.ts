import { AppError, db } from "./db";
import { watchSections } from "./watch-sources";
import {
  parseRelease,
  releaseCalendar,
  titleRelease,
  type StoredRelease,
} from "./title-release";
import {
  watchCategories,
  type Episode,
  type Season,
  type Title,
  type TitleRelease,
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
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
// Details for a requested title must carry its TMDB ID, so a mismatched
// response is never stored or served under either ID.
function parseTitle(
  raw: unknown,
  kind: "movie" | "tv",
  requestedId?: number,
): Title {
  const name = isRecord(raw) && (kind === "movie" ? raw.title : raw.name);
  if (
    !isRecord(raw) ||
    !Number.isSafeInteger(raw.id) ||
    Number(raw.id) <= 0 ||
    (requestedId !== undefined && raw.id !== requestedId) ||
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
  if (!isRecord(data) || !Array.isArray(data.results))
    throw new AppError("The catalog returned invalid search results.", 502);
  return data.results
    .filter(
      (r): r is Record<string, unknown> =>
        isRecord(r) && (r.media_type === "movie" || r.media_type === "tv"),
    )
    .map((r) => parseTitle(r, r.media_type as "movie" | "tv"));
}
type TitleRow = Title & { release: StoredRelease | null };
const titleColumns =
  "id,kind,tmdb_id,name,overview,poster_path,release_date,release";
const currentTitle =
  "(fetched_at>now()-interval '1 day' OR retry_after>now()) IS TRUE AS current";
function presentTitle({ release, ...title }: TitleRow & { current?: boolean }) {
  delete title.current;
  return { title: title as Title, release: titleRelease(title.kind, release) };
}

// Fetches a title's details, with a movie's release dates in the same
// request, and stores them. When TMDB fails, times out, returns invalid
// details, or no longer has the title, the stored row is served and the
// refresh waits five minutes; only a title that was never stored throws.
// Details without usable release dates are stored, but count as a failed
// refresh: the last release data stays and the refresh waits five minutes.
async function refreshTitle(id: string, stored?: TitleRow): Promise<TitleRow> {
  const [kind, tmdbId] = id.split(":") as ["movie" | "tv", string];
  let title: Title;
  let release: StoredRelease | null;
  try {
    const raw = await fetchCatalog(
      `/${kind}/${tmdbId}${kind === "movie" ? "?append_to_response=release_dates" : ""}`,
      stored ? 2000 : 8000,
    );
    title = parseTitle(raw, kind, Number(tmdbId));
    release = parseRelease(raw as Record<string, unknown>, kind);
  } catch (error) {
    if (!stored) throw error;
    await db.query(
      "UPDATE title SET retry_after=now()+interval '5 minutes' WHERE id=$1",
      [id],
    );
    return stored;
  }
  const save = () =>
    db.query<{ release: StoredRelease | null }>(
      `INSERT INTO title(id,kind,tmdb_id,name,overview,poster_path,release_date,release,fetched_at,retry_after)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,
      CASE WHEN $8::jsonb IS NULL THEN 'epoch'::timestamptz ELSE now() END,
      CASE WHEN $8::jsonb IS NULL THEN now()+interval '5 minutes' END)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,overview=excluded.overview,poster_path=excluded.poster_path,
    release_date=excluded.release_date,release=coalesce(excluded.release,title.release),
    fetched_at=CASE WHEN excluded.release IS NULL THEN title.fetched_at ELSE now() END,
    retry_after=excluded.retry_after
    RETURNING release`,
      [
        title.id,
        title.kind,
        title.tmdb_id,
        title.name,
        title.overview,
        title.poster_path,
        title.release_date,
        release && JSON.stringify(release),
      ],
    );
  let saved;
  try {
    saved = await save();
  } catch (error) {
    // A concurrent first fetch of the same title can win its (kind, tmdb_id)
    // index before the ID conflict is seen. The title is then stored, so the
    // retry updates it.
    if ((error as { code?: string }).code !== "23505") throw error;
    saved = await save();
  }
  return { ...title, release: saved.rows[0].release };
}

// Stored details refresh after a day. Only a title that was never stored
// depends on the catalog response.
export async function getTitleWithRelease(
  id: string,
): Promise<{ title: Title; release: TitleRelease }> {
  if (!/^(movie|tv):[1-9][0-9]*$/.test(id))
    throw new AppError("Title not found.", 404);
  const stored = (
    await db.query<TitleRow & { current: boolean }>(
      `SELECT ${titleColumns},${currentTitle} FROM title WHERE id=$1`,
      [id],
    )
  ).rows[0];
  if (stored?.current) return presentTitle(stored);
  return presentTitle(await refreshTitle(id, stored));
}

export async function getTitle(id: string): Promise<Title> {
  return (await getTitleWithRelease(id)).title;
}

// Release status for a title list, in the order of `ids`. Reads every stored
// title in one query, then refreshes only missing or expired details, at
// most four at a time, as for availability. No request starts at or after
// `refreshBefore`; those titles keep their stored dates, or an unavailable
// status when they have none. A title that is not stored is unavailable.
export async function getTitleReleases(
  ids: string[],
  refreshBefore = Infinity,
): Promise<TitleRelease[]> {
  const results = new Map<string, TitleRelease>();
  const valid = [...new Set(ids)].filter((id) =>
    /^(movie|tv):[1-9][0-9]*$/.test(id),
  );
  // One date for the whole list, even across midnight.
  const today = releaseCalendar.today();
  try {
    const { rows } = valid.length
      ? await db.query<TitleRow & { current: boolean }>(
          `SELECT ${titleColumns},${currentTitle} FROM title WHERE id=ANY($1::text[])`,
          [valid],
        )
      : { rows: [] };
    const due: TitleRow[] = [];
    for (const row of rows) {
      results.set(row.id, titleRelease(row.kind, row.release, today));
      if (!row.current) due.push(row);
    }
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, due.length) }, async () => {
        while (next < due.length && Date.now() < refreshBefore) {
          const row = due[next++];
          try {
            const { release } = await refreshTitle(row.id, row);
            results.set(row.id, titleRelease(row.kind, release, today));
          } catch {
            // A failed write keeps the stored dates already in `results`.
          }
        }
      }),
    );
  } catch {
    // An unreadable title table leaves every release unavailable.
  }
  return ids.map((id) => results.get(id) ?? titleRelease("movie", null));
}

// The movie or show TMDB lists under an IMDb ID, such as `tt0111161`, as a
// title ID. An episode's or season's ID names its show. Null when TMDB has
// none.
export async function findImdbTitle(imdbId: string): Promise<string | null> {
  if (!/^tt\d{7,9}$/.test(imdbId)) return null;
  let data: unknown;
  try {
    data = await fetchCatalog(`/find/${imdbId}?external_source=imdb_id`, 5000);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) return null;
    throw error;
  }
  if (!isRecord(data))
    throw new AppError("The catalog returned an invalid title.", 502);
  const first = (key: string, field = "id") => {
    const list = data[key];
    const value =
      Array.isArray(list) && isRecord(list[0]) ? list[0][field] : undefined;
    return Number.isSafeInteger(value) && Number(value) > 0
      ? Number(value)
      : null;
  };
  const movie = first("movie_results");
  if (movie) return `movie:${movie}`;
  const show =
    first("tv_results") ??
    first("tv_episode_results", "show_id") ??
    first("tv_season_results", "show_id");
  return show ? `tv:${show}` : null;
}

// Actions and comments need only a stored title, even with stale details.
// Returns the stored ID, fetching the title only if it was never stored.
export async function ensureTitle(id: string): Promise<string> {
  if ((await db.query("SELECT 1 FROM title WHERE id=$1", [id])).rowCount)
    return id;
  return (await getTitle(id)).id;
}

// The TV discussion composer's Season and Episode pickers read TMDB's lists
// when a member opens it. Specials (season 0) have no "Season N" label, so
// they are left out. A failed request leaves the post without a label.
function showPath(id: string) {
  if (!/^(movie|tv):[1-9][0-9]*$/.test(id))
    throw new AppError("Title not found.", 404);
  if (!id.startsWith("tv:"))
    throw new AppError("Seasons are only for TV shows.", 404);
  return `/tv/${id.slice(3)}`;
}
const positive = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
function invalidCatalog(): never {
  throw new AppError("The catalog returned an invalid season list.", 502);
}

export async function titleSeasons(id: string): Promise<Season[]> {
  const data = await fetchCatalog(showPath(id), 5000);
  if (!isRecord(data) || !Array.isArray(data.seasons)) invalidCatalog();
  return data.seasons
    .filter((season) => isRecord(season) && positive(season.season_number))
    .map((season) => ({
      number: Number(season.season_number),
      name:
        typeof season.name === "string" && season.name.trim()
          ? season.name.trim()
          : `Season ${season.season_number}`,
    }));
}

export async function seasonEpisodes(
  id: string,
  season: number,
): Promise<Episode[]> {
  const path = showPath(id);
  if (!positive(season)) throw new AppError("Invalid season.");
  const data = await fetchCatalog(`${path}/season/${season}`, 5000);
  if (!isRecord(data) || !Array.isArray(data.episodes)) invalidCatalog();
  return data.episodes
    .filter((episode) => isRecord(episode) && positive(episode.episode_number))
    .map((episode) => ({
      number: Number(episode.episode_number),
      name: typeof episode.name === "string" ? episode.name.trim() : "",
    }));
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
// The cache references the stored title, so a request made alongside the
// title's first fetch waits for `titleStored` before writing.
export async function getTitleTrailer(
  id: string,
  titleStored: Promise<unknown> = Promise.resolve(),
): Promise<Trailer | null> {
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
    await titleStored;
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

async function readCachedAvailability(ids: string[]) {
  const { rows } = await db.query<CachedAvailability & { title_id: string }>(
    "SELECT title_id,availability,fetched_at,refresh_after FROM title_availability WHERE title_id=ANY($1::text[]) AND country='US'",
    [ids],
  );
  return new Map(rows.map(({ title_id, ...cached }) => [title_id, cached]));
}

// Fetch only optional public metadata here. A failed refresh must neither
// erase the last success nor be retried on every title-screen poll. Cache
// writes wait for `titleStored`, as for trailers.
async function refreshAvailability(
  id: string,
  cached: CachedAvailability | undefined,
  titleStored: Promise<unknown>,
): Promise<WatchAvailability> {
  try {
    let availability: AvailabilityData;
    try {
      availability = parseAvailability(
        await fetchCatalog(`/${id.replace(":", "/")}/watch/providers`, 2000),
        id,
      );
    } catch {
      await titleStored;
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
    await titleStored;
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

// Read every cached entry in one query, then call the provider only for
// missing or expired entries, at most four at a time. No request starts at or
// after `refreshBefore`; those titles keep their cached or unknown state.
// Results follow the order of `ids`.
export async function getTitleAvailabilities(
  ids: string[],
  refreshBefore = Infinity,
  titleStored: Promise<unknown> = Promise.resolve(),
): Promise<WatchAvailability[]> {
  const results = new Map<string, WatchAvailability>();
  const valid = [...new Set(ids)].filter((id) =>
    /^(movie|tv):[1-9][0-9]*$/.test(id),
  );
  let cached = new Map<string, CachedAvailability>();
  try {
    if (valid.length) cached = await readCachedAvailability(valid);
    const due: string[] = [];
    for (const id of valid) {
      const entry = cached.get(id);
      results.set(id, availabilityResult(entry));
      if (!entry || entry.refresh_after.getTime() <= Date.now()) due.push(id);
    }
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, due.length) }, async () => {
        while (next < due.length && Date.now() < refreshBefore) {
          const id = due[next++];
          results.set(
            id,
            await refreshAvailability(id, cached.get(id), titleStored),
          );
        }
      }),
    );
  } catch {
    // An unreadable cache leaves every title unknown without provider calls.
  }
  return ids.map((id) => results.get(id) ?? availabilityResult());
}

export async function getTitleAvailability(
  id: string,
  refreshBefore = Infinity,
  titleStored: Promise<unknown> = Promise.resolve(),
): Promise<WatchAvailability> {
  return (await getTitleAvailabilities([id], refreshBefore, titleStored))[0];
}
