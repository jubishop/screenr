import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { AppError } from "./db";
import { member } from "./social";

export async function signedIn() {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  return session;
}
export async function currentMember() {
  const session = await signedIn();
  try {
    return await member(session.user.id);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) redirect("/setup");
    throw error;
  }
}
