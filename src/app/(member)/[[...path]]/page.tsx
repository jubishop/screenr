import { redirect } from "next/navigation";
import { currentMember } from "../../../server/session";
import { loadScreen } from "../../../server/screens";
import { AppError } from "../../../server/db";
import { Screen } from "../../../components/screen";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentMember();
  const path = "/" + ((await params).path ?? []).join("/");
  const query = await searchParams;
  const initialGoogleError =
    path !== "/account" || !query.error
      ? ""
      : query.error === "access_denied"
        ? "Google connection was canceled. You can try again."
        : query.error === "email_does_not_match"
          ? "Choose the Google account with the same email address as your Screenr account."
          : "Google could not be connected. Please try again.";
  const target = new URLSearchParams();
  for (const key of ["item", "reply"])
    if (typeof query[key] === "string") target.set(key, query[key]);
  if (path === "/watch-together") {
    const usernames = query.with;
    for (const username of typeof usernames === "string"
      ? [usernames]
      : (usernames ?? []))
      target.append("with", username);
  }
  const requestedPath = path + (target.size ? `?${target}` : "");
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
