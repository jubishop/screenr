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
  let initialData = null,
    initialError = "";
  try {
    initialData = JSON.parse(
      JSON.stringify(await loadScreen(user.user_id, path)),
    );
  } catch (error) {
    initialError =
      error instanceof AppError
        ? error.message
        : "This page could not load. Please try again.";
  }
  return (
    <Screen
      key={path}
      user={user}
      path={path}
      initialData={initialData}
      initialError={initialError}
      initialGoogleError={initialGoogleError}
    />
  );
}
