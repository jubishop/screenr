import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
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
// on the website for usage telemetry. Background screen refreshes use the
// API instead. The member page and its not-found view share this lookup in
// each request.
const requestMember = cache(async () => {
  const session = await auth().api.getSession({ headers: await headers() });
  if (!session) return "signed out" as const;
  try {
    const person = await member(session.user.id);
    await recordActiveDay(person.user_id, "web");
    return person;
  } catch (error) {
    if (error instanceof AppError && error.status === 403)
      return "no profile" as const;
    throw error;
  }
});
export async function currentMember(path: string) {
  const person = await requestMember();
  if (person === "signed out") redirect(loginPath(path));
  if (person === "no profile") redirect(setupPath(path));
  return person;
}
// The not-found view appears only after the page admitted the member, so it
// leaves redirects to the page.
export async function admittedMember() {
  const person = await requestMember();
  return typeof person === "string" ? null : person;
}
