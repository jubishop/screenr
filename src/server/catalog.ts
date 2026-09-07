import { AppError, db } from "./db";
import type { Title } from "../shared";

function catalogConfig() {
  const base =
    process.env.SCREENR_TEST_TMDB_URL ?? "https://api.themoviedb.org/3";
  if (
    process.env.SCREENR_TEST_TMDB_URL &&
    (process.env.NODE_ENV === "production" ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
  ) {
    throw new Error(
      "The catalog test server is allowed only on loopback outside production.",
    );
  }
  if (!process.env.TMDB_READ_TOKEN && !process.env.SCREENR_TEST_TMDB_URL)
    throw new AppError("The movie catalog is not configured yet.", 503);
  return { base, token: process.env.TMDB_READ_TOKEN ?? "test" };
}
async function fetchCatalog(path: string) {
  const { base, token } = catalogConfig();
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
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
