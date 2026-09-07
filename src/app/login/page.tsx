import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SignIn } from "../../components/sign-in";
import { activeInvitation, invitationHash } from "../../server/invitations";
export const dynamic = "force-dynamic";
// Invite links redirect here. Keep previews public and independent of cookies,
// and omit a canonical/og:url so the shared invitation remains the destination.
export const metadata: Metadata = {
  metadataBase: new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000"),
  openGraph: {
    type: "website",
    siteName: "Screenr",
    title: "Your next great watch starts with a friend.",
    description: "Find your next movie or show through your friends.",
  },
  twitter: { card: "summary_large_image" },
};
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
      googleEnabled={
        !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
      }
      initialError={initialError}
    />
  );
}
