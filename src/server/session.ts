import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { loginPath, setupPath } from "../member-routes";
import { auth } from "./auth";
import { AppError } from "./db";
import { member } from "./profiles";
import { recordActiveDay } from "./usage";

// `next` is the member path to return to after sign-in and setup.
export async function signedIn(next?: string) {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) redirect(loginPath(next));
  return session;
}
// Member page renders, including client navigation, count as an active day
// for usage telemetry. Background screen refreshes use the API instead.
export async function currentMember(path: string) {
  const session = await signedIn(path);
  let person;
  try {
    person = await member(session.user.id);
  } catch (error) {
    if (error instanceof AppError && error.status === 403)
      redirect(setupPath(path));
    throw error;
  }
  await recordActiveDay(person.user_id);
  return person;
}
