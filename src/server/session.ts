import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { AppError } from "./db";
import { member } from "./profiles";
import { recordActiveDay } from "./usage";

export async function signedIn() {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) redirect("/login");
  return session;
}
// Member page renders, including client navigation, count as an active day
// for usage telemetry. Background screen refreshes use the API instead.
export async function currentMember() {
  const session = await signedIn();
  let person;
  try {
    person = await member(session.user.id);
  } catch (error) {
    if (error instanceof AppError && error.status === 403) redirect("/setup");
    throw error;
  }
  await recordActiveDay(person.user_id);
  return person;
}
