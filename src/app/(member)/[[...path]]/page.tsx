import { redirect } from "next/navigation";
import { currentMember } from "../../../server/session";
import { loadScreen } from "../../../server/screens";
import { AppError } from "../../../server/db";
import { Screen } from "../../../components/screen";
import { memberPath, parseMemberRoute } from "../../../member-routes";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentMember();
  const segments = (await params).path ?? [];
  const query = await searchParams;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    for (const entry of [value ?? []].flat()) search.append(key, entry);
  const route = parseMemberRoute(
    `/${segments.map(encodeURIComponent).join("/")}?${search}`,
  );
  const initialGoogleError =
    route.kind !== "account" || !query.error
      ? ""
      : query.error === "access_denied"
        ? "Google connection was canceled. You can try again."
        : query.error === "email_does_not_match"
          ? "Choose the Google account with the same email address as your Screenr account."
          : "Google could not be connected. Please try again.";
  const requestedPath = memberPath(route);
  let initialData = null,
    initialError = "";
  try {
    initialData = JSON.parse(
      JSON.stringify(await loadScreen(user.user_id, requestedPath)),
    );
  } catch (error) {
    initialError =
      error instanceof AppError
        ? error.message
        : "This page could not load. Please try again.";
  }
  if (initialData?.kind === "redirect") redirect(initialData.url);
  return (
    <Screen
      key={requestedPath}
      user={user}
      path={requestedPath}
      initialData={initialData}
      initialError={initialError}
      initialGoogleError={initialGoogleError}
    />
  );
}
