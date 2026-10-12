import { redirect } from "next/navigation";
import { Setup } from "../../components/sign-in";
import { returnPath } from "../../member-routes";
import { signedIn } from "../../server/session";
import { db } from "../../server/db";
import { photoSetup } from "../../server/photos";
export const dynamic = "force-dynamic";
// Sign-in lands here, so members continue to the page they first requested.
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = returnPath((await searchParams).next);
  const session = await signedIn(next);
  if (
    (
      await db.query("SELECT 1 FROM profile WHERE user_id=$1", [
        session.user.id,
      ])
    ).rowCount
  )
    redirect(next ?? "/");
  const { photo, google } = await photoSetup(session.user.id);
  return (
    <Setup
      userId={session.user.id}
      email={session.user.email}
      name={session.user.name}
      verified={session.user.emailVerified}
      next={next}
      photo={photo}
      google={google}
    />
  );
}
