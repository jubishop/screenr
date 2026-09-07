import { redirect } from "next/navigation";
import { Setup } from "../../components/sign-in";
import { signedIn } from "../../server/session";
import { db } from "../../server/db";
export const dynamic = "force-dynamic";
export default async function SetupPage() {
  const session = await signedIn();
  if (
    (
      await db.query("SELECT 1 FROM profile WHERE user_id=$1", [
        session.user.id,
      ])
    ).rowCount
  )
    redirect("/");
  return (
    <Setup
      email={session.user.email}
      name={session.user.name}
      verified={session.user.emailVerified}
    />
  );
}
