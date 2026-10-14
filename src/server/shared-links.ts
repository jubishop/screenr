import { findImdbTitle, getTitle } from "./catalog";
import { AppError } from "./db";
import type { Title } from "../shared";

// The iPhone share extension sends the link it was given and any text shared
// with it, such as Safari's page title or another app's message
// (docs/title-catalog.md#shared-links). TMDB links name a title, IMDb links
// resolve through TMDB, and JustWatch links through the IMDb ID on their
// title page. Netflix's title pages name the title but no other catalog's
// ID, so they give only the search. Without a title, `query` is the text the
// extension's search starts from.
export type SharedTitle = { title: Title | null; query: string };

type Source =
  | { kind: "tmdb"; id: string }
  | { kind: "imdb"; imdbId: string }
  | { kind: "justwatch"; path: string; name: string }
  | { kind: "netflix"; path: string };

export async function resolveSharedTitle(
  url: string,
  text: string,
): Promise<SharedTitle> {
  if (url.length > 2048) throw new AppError("Share a shorter link.");
  const shared = text.slice(0, 1000);
  const link = webLink(url) ?? webLink(/https?:\/\/[^\s<>"“”]+/i.exec(shared));
  const source = link && linkSource(link);
  let query = sharedSearchText(shared);
  let id: string | null = null;
  if (source?.kind === "tmdb") id = source.id;
  if (source?.kind === "imdb") id = await findImdbTitle(source.imdbId);
  if (source?.kind === "justwatch") {
    const imdbId = justWatchImdbId(await sitePage("justwatch", source.path));
    if (imdbId) id = await findImdbTitle(imdbId);
    query = source.name || query;
  }
  if (source?.kind === "netflix")
    query = netflixName(await sitePage("netflix", source.path)) || query;
  if (!id) return { title: null, query };
  try {
    return { title: await getTitle(id), query: "" };
  } catch (error) {
    if (error instanceof AppError && error.status === 404)
      return { title: null, query };
    throw error;
  }
}

function webLink(value: string | RegExpExecArray | null) {
  const text = typeof value === "string" ? value : value?.[0];
  if (!text || !URL.canParse(text)) return null;
  const url = new URL(text);
  return url.protocol === "https:" || url.protocol === "http:" ? url : null;
}

function linkSource(url: URL): Source | null {
  const host = url.hostname.toLowerCase().replace(/^(www|m)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  // A localized page's path starts with its language, such as /de/ or /en-gb/.
  const localized = (at: number) =>
    at === 0 || (at === 1 && /^[a-z]{2}(-[a-z]{2})?$/i.test(parts[0]));
  if (host === "themoviedb.org") {
    // /movie/42-fight-club, and its pages, such as /tv/1399/season/1.
    const [kind, page] = parts;
    const tmdbId = /^([1-9]\d{0,9})(?:-|$)/.exec(page ?? "")?.[1];
    if ((kind === "movie" || kind === "tv") && tmdbId)
      return { kind: "tmdb", id: `${kind}:${tmdbId}` };
  }
  if (host === "imdb.com") {
    // /title/tt0111161/, or a localized /de/title/tt0111161/.
    const at = parts.indexOf("title");
    const imdbId = parts[at + 1];
    if (localized(at) && /^tt\d{7,9}$/.test(imdbId))
      return { kind: "imdb", imdbId };
  }
  if (host === "justwatch.com") {
    // /us/movie/dune-2021 or /de/serie/dark, and its pages, such as a season.
    const page = parts.slice(0, 3);
    if (
      page.length === 3 &&
      /^[a-z]{2}$/i.test(page[0]) &&
      page.every((part) => /^[\w-]{1,200}$/.test(part))
    )
      return {
        kind: "justwatch",
        path: `/${page.join("/")}`,
        name: page[2]
          .replace(/-(?:19|20)\d{2}$/, "")
          .replaceAll(/[-_]+/g, " ")
          .trim(),
      };
  }
  if (host === "netflix.com") {
    // /title/80057281, or a localized /gb/title/80057281.
    const at = parts.indexOf("title");
    const netflixId = parts[at + 1];
    if (localized(at) && /^\d{1,12}$/.test(netflixId ?? ""))
      return { kind: "netflix", path: `/title/${netflixId}` };
  }
  return null;
}

const siteOrigins = {
  justwatch: "https://www.justwatch.com",
  netflix: "https://www.netflix.com",
};

// Tests serve both sites' pages from one loopback server.
function siteOrigin(site: keyof typeof siteOrigins) {
  const test = process.env.SCREENR_TEST_PAGES_URL;
  if (!test) return siteOrigins[site];
  if (
    process.env.NODE_ENV === "production" ||
    !/^http:\/\/127\.0\.0\.1:\d+$/.test(test)
  )
    throw new Error(
      "The JustWatch and Netflix test server requires loopback outside production.",
    );
  return test;
}

// A title page on JustWatch or Netflix, or null. Only the page's own path is
// requested, within five seconds, and only redirects within the site are
// followed.
async function sitePage(site: keyof typeof siteOrigins, path: string) {
  const origin = siteOrigin(site);
  const signal = AbortSignal.timeout(5000);
  let url = new URL(path, origin);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(url, {
        redirect: "manual",
        signal,
        cache: "no-store",
        headers: { Accept: "text/html" },
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        url = new URL(location, url);
        if (url.origin !== origin) return null;
        continue;
      }
      if (!response.ok || !response.body) return null;
      return await pageText(response.body);
    }
  } catch {
    return null;
  }
  return null;
}

// Title pages run about 1.5 MB. A larger one is not a title page.
async function pageText(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 5_000_000) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// A JustWatch title page names one IMDb ID in its embedded state. A page
// with none, or with several, gives null.
function justWatchImdbId(page: string | null) {
  const ids = new Set(page?.match(/"tt\d{7,9}"/g));
  return ids.size === 1 ? [...ids][0].slice(1, -1) : null;
}

// A Netflix title page's heading is the title's name. Its <title> is only
// "Netflix", and it carries no other catalog's ID.
function netflixName(page: string | null) {
  const heading = page && /<h1[^>]*>([^<]{1,200})<\/h1>/i.exec(page)?.[1];
  if (!heading) return "";
  const name = heading
    .replaceAll(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replaceAll(/&#x([\da-f]+);/gi, (_, code) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll(/\s+/g, " ")
    .trim();
  return isSite(name) ? "" : name.slice(0, 120);
}

const sites = new Set([
  "amazon prime video",
  "apple tv",
  "apple tv+",
  "disney+",
  "hbo max",
  "hulu",
  "imdb",
  "justwatch",
  "letterboxd",
  "max",
  "netflix",
  "netflix official site",
  "prime video",
  "rotten tomatoes",
  "screenr",
  "the movie database",
  "the movie database (tmdb)",
  "tmdb",
  "youtube",
]);
const isSite = (text = "") => sites.has(text.trim().toLowerCase());

// The title a shared message or page title names, for a TMDB search: a
// quoted name, or the text without links, site names, "Watch" or "Check
// out", or a trailing year or kind, such as "Stranger Things" from "Watch
// Stranger Things | Netflix" or "Fight Club" from "Fight Club (1999) - IMDb".
export function sharedSearchText(text: string) {
  let value = text.replaceAll(/https?:\/\/\S+/gi, " ");
  const quoted = /[“"«]([^”"»]{1,200})[”"»]/.exec(value);
  if (quoted) value = quoted[1];
  value = value.replaceAll(/\s+/g, " ").trim();
  const pieces = value.split(/( [|–—·-] )/);
  let removed = false;
  while (pieces.length >= 3 && isSite(pieces.at(-1))) {
    pieces.splice(-2, 2);
    removed = true;
  }
  while (pieces.length >= 3 && isSite(pieces[0])) {
    pieces.splice(0, 2);
    removed = true;
  }
  value = pieces.join("");
  const onSite = /^(.*\S) on (.+?)[.!]?$/i.exec(value);
  if (onSite && isSite(onSite[2])) {
    value = onSite[1];
    removed = true;
  }
  if (removed) value = value.replace(/^(watch|check out) /i, "");
  if (isSite(value)) return "";
  return value
    .replace(
      / ?\([^()]*(?:\b(?:19|20)\d{2}\b|\b(?:TV|Series|Movie|Film)\b)[^()]*\)$/i,
      "",
    )
    .slice(0, 120)
    .trim();
}
