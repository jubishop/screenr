import { cookies } from "next/headers";
import { SignIn } from "../../components/sign-in";
import { activeInvitation, invitationHash } from "../../server/invitations";
export const dynamic = "force-dynamic";
export default async function Login({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const token = (await cookies()).get("screenr-invite")?.value;
  const query = await searchParams;
  const invited = !!token && !!(await activeInvitation(invitationHash(token)));
  const initialError = query.error
    ? "To connect Google to an existing account, sign in with an email code first, then connect Google in Account."
    : query.invitation
      ? "That invitation is no longer available. Existing members can still sign in."
      : "";
  return (
    <SignIn
      invited={invited}
      googleEnabled={!!process.env.GOOGLE_CLIENT_ID}
      initialError={initialError}
    />
  );
}
