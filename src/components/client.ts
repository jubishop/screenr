"use client";
import { useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
export const authClient = createAuthClient({ plugins: [emailOTPClient()] });
export async function signOut() {
  const result = await authClient.signOut();
  if (result.error || !result.data?.success)
    throw new Error(
      result.error?.message || "Could not sign out. Please try again.",
    );
  window.location.assign("/login");
}
export async function api<T = Record<string, unknown>>(
  action: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/screenr/${action}`, {
    method: data === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  if (response.status === 401) {
    window.location.replace("/login");
    throw new Error("Sign in to continue.");
  }
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error ?? "Request failed. Please try again.");
  return result as T;
}

export function useInteractive() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}

export function dateLabel(
  value: string,
  interactive: boolean,
  options: Intl.DateTimeFormatOptions = {},
) {
  const date = new Date(value);
  // Even with en-US and UTC, locale punctuation differs between runtimes.
  // Use ISO fields for hydration, then localize once the client is ready.
  if (!interactive) {
    if (Number.isNaN(date.getTime())) return "Invalid Date";
    const iso = date.toISOString();
    return options.hour || options.minute
      ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
      : iso.slice(0, 10);
  }
  return date.toLocaleDateString("en-US", options);
}
