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
  // The server cannot know the browser's time zone. Use a stable first render,
  // then show the reader's local date once the client is ready.
  return new Date(value).toLocaleDateString("en-US", {
    ...options,
    ...(!interactive ? { timeZone: "UTC" } : {}),
  });
}
