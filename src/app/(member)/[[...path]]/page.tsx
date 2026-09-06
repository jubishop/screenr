import { currentMember } from "../../../server/session";
import { loadScreen } from "../../../server/screens";
import { AppError } from "../../../server/db";
import { Screen } from "../../../components/screen";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ path?: string[] }>;
}) {
  const user = await currentMember();
  const path = "/" + ((await params).path ?? []).join("/");
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
    />
  );
}
