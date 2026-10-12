// Member pages share one catch-all route. The page, the screen loader, and the
// browser shell read requested paths through this parser, so they agree on
// which screen a URL names and which of its query parameters matter. Sign-in
// accepts only these paths as return paths.
type ItemTarget = { item?: string; reply?: string };
export type MemberRoute =
  | ({ kind: "feed" } & ItemTarget)
  | { kind: "search"; q?: string }
  | { kind: "people" }
  | { kind: "invites" }
  | { kind: "account" }
  | { kind: "watch-together"; with: string[] }
  | ({ kind: "title"; id: string } & ItemTarget)
  | { kind: "profile"; username: string }
  | { kind: "conversation"; id: string; reply?: string }
  | { kind: "not-found"; path: string };

const pages = ["people", "invites", "account"] as const;
const origin = "http://screenr.local";

/** Parses a member path and its query, such as `/titles/movie/1?item=…`. */
export function parseMemberRoute(path: string): MemberRoute {
  const url = new URL(path, origin);
  const param = (key: string) => url.searchParams.get(key) || undefined;
  const target = () => ({ item: param("item"), reply: param("reply") });
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return { kind: "not-found", path: url.pathname };
  }
  const [section, ...rest] = parts;
  if (!parts.length) return { kind: "feed", ...target() };
  if (!rest.length) {
    // Search trims its query, so whitespace alone names no search.
    if (section === "search")
      return { kind: section, q: param("q")?.trim() || undefined };
    if (section === "watch-together")
      return { kind: section, with: url.searchParams.getAll("with") };
    const page = pages.find((name) => name === section);
    if (page) return { kind: page };
  }
  if (section === "titles" && rest.length === 2)
    return { kind: "title", id: rest.join(":"), ...target() };
  if (section === "people" && rest.length === 1)
    return { kind: "profile", username: rest[0] };
  if (section === "conversations" && rest.length === 1)
    return { kind: "conversation", id: rest[0], reply: param("reply") };
  return { kind: "not-found", path: url.pathname };
}

/** Returns a route's canonical path, keeping only the parameters it uses. */
export function memberPath(route: MemberRoute): string {
  switch (route.kind) {
    case "feed":
      return withQuery("/", route);
    case "title": {
      const [kind, ...tmdbId] = route.id.split(":");
      return withQuery(`/titles/${segments(kind, tmdbId.join(":"))}`, route);
    }
    case "search":
      return withQuery("/search", { q: route.q });
    case "watch-together":
      return withQuery("/watch-together", { with: route.with });
    case "profile":
      return `/people/${segments(route.username)}`;
    case "conversation":
      return withQuery(`/conversations/${segments(route.id)}`, {
        reply: route.reply,
      });
    case "not-found":
      return route.path;
    default:
      return `/${route.kind}`;
  }
}

function withQuery(
  path: string,
  {
    item,
    reply,
    q,
    with: usernames = [],
  }: ItemTarget & { q?: string; with?: string[] },
) {
  const query = new URLSearchParams();
  if (item) query.set("item", item);
  if (reply) query.set("reply", reply);
  if (q) query.set("q", q);
  for (const username of usernames) query.append("with", username);
  return query.size ? `${path}?${query}` : path;
}

function segments(...parts: string[]) {
  return parts.map(encodeURIComponent).join("/");
}

/**
 * Returns the canonical member path for a requested return path, or undefined
 * unless it is a root-relative path naming a member screen. Rejecting
 * protocol-relative, backslash, control-character, and unknown paths keeps
 * sign-in redirects on Screenr.
 */
export function returnPath(next: unknown): string | undefined {
  if (
    typeof next !== "string" ||
    !next.startsWith("/") ||
    /^\/\/|[\\\u0000-\u001f\u007f]/.test(next)
  )
    return undefined;
  const url = new URL(next, origin);
  if (url.origin !== origin) return undefined;
  const route = parseMemberRoute(url.pathname + url.search);
  return route.kind === "not-found" ? undefined : memberPath(route);
}

/** The sign-in page, returning to a valid member path other than the feed. */
export function loginPath(next?: string) {
  return withReturn("/login", next);
}

/** The setup page, which continues to a valid member path afterward. */
export function setupPath(next?: string) {
  return withReturn("/setup", next);
}

function withReturn(page: string, next?: string) {
  const path = returnPath(next);
  return path && path !== "/"
    ? `${page}?next=${encodeURIComponent(path)}`
    : page;
}
