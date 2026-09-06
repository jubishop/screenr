"use client";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
export const authClient = createAuthClient({ plugins: [emailOTPClient()] });
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
