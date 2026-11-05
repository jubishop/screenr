import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { currentMember } from "../../../server/session";
import {
  initialScreen,
  readVersion,
  screenResponse,
} from "../../../server/screens";
import { Screen } from "../../../components/screen";
import {
  initialFindFilters,
  memberPath,
  newestHistory,
  parseMemberRoute,
  screenPath,
} from "../../../member-routes";
export const dynamic = "force-dynamic";
// The screen renders each member page's title, so client navigation and
// refreshes change it in the same render as the page. Drop the layout's title.
export const metadata: Metadata = { title: null };
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const segments = (await params).path ?? [];
  const query = await searchParams;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    for (const entry of [value ?? []].flat()) search.append(key, entry);
  const route = parseMemberRoute(
    `/${segments.map(encodeURIComponent).join("/")}?${search}`,
  );
  const requestedPath = memberPath(route);
  const user = await currentMember(requestedPath);
  const initialGoogleError =
    route.kind !== "account" || !query.error
      ? ""
      : query.error === "access_denied"
        ? "Google connection was canceled. You can try again."
        : query.error === "email_does_not_match"
          ? "Choose the Google account with the same email address as your Screenr account."
          : "Google could not be connected. Please try again.";
  // The first screen is read as the browser's screen reads it, with Find a
  // title's filters as each visit starts them and the newest page of a feed
  // or profile.
  const screen = await initialScreen(
    user.user_id,
    screenPath(requestedPath, initialFindFilters, newestHistory),
  );
  // A missing title, person, or page responds 404 through not-found.tsx.
  if (screen.status === 404) notFound();
  if (screen.data?.kind === "redirect") redirect(screen.data.url);
  // The page's screen is the JSON a screen read sends, so it has that read's
  // version, and its dates arrive as the same strings. Serializing it once
  // gives both.
  const body = screen.data && JSON.stringify(screenResponse(screen.data, user));
  return (
    <Screen
      key={requestedPath}
      user={user}
      path={requestedPath}
      initialData={body && JSON.parse(body)}
      initialVersion={body && readVersion(body)}
      initialError={screen.error}
      initialStatus={screen.status}
      initialGoogleError={initialGoogleError}
    />
  );
}
