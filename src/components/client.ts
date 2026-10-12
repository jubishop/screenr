"use client";
import { useEffect, useState } from "react";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { loginPath, returnPath } from "../member-routes";
// `status` is the HTTP status, or undefined when no response arrived.
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
// Every request, including Better Auth's, stops waiting here, so a stalled
// request releases its controls. Writes can wait on the catalog's
// eight-second timeout. Reads also pass shorter deadlines with their own
// messages.
const requestDeadline = 15_000;
const unavailable =
  "Screenr is temporarily unavailable. Please try again in a moment.";
// The deadline also covers the body, so the whole reply is read here.
async function send(input: string | URL | Request, init: RequestInit) {
  const deadline = AbortSignal.timeout(requestDeadline);
  const { signal } = init;
  try {
    const response = await fetch(input, {
      ...init,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    return { response, text: await response.text() };
  } catch (error) {
    // Callers recognize their own cancellations and read timeouts.
    if (signal?.aborted) throw error;
    throw new ApiError(
      deadline.aborted
        ? "The request timed out. Please try again."
        : "Could not reach Screenr. Check your connection and try again.",
    );
  }
}
// Better Auth parses the buffered reply. A failed request rejects with the
// message above, which the caller shows beside its control.
export const authClient = createAuthClient({
  plugins: [emailOTPClient()],
  fetchOptions: {
    async customFetchImpl(input, init = {}) {
      const { response, text } = await send(input, init);
      return new Response(text || null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  },
});
export async function signOut() {
  const result = await authClient.signOut();
  if (result.error || !result.data?.success)
    throw new Error(
      result.error?.message || "Could not sign out. Please try again.",
    );
  window.location.assign("/login");
}
// A Blob, such as a photo, is sent as the raw request body; other data as JSON.
export async function api<T = Record<string, unknown>>(
  action: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const { response, text } = await send(`/api/screenr/${action}`, {
    method: data === undefined ? "GET" : "POST",
    cache: "no-store",
    signal,
    headers:
      data === undefined
        ? {}
        : {
            "Content-Type":
              data instanceof Blob ? data.type : "application/json",
          },
    body:
      data === undefined || data instanceof Blob ? data : JSON.stringify(data),
  });
  if (response.status === 401) {
    // Return to this member page, or to the one setup was continuing to.
    const { pathname, search } = window.location;
    window.location.replace(
      loginPath(
        returnPath(pathname + search) ??
          returnPath(new URLSearchParams(search).get("next")),
      ),
    );
    throw new ApiError("Sign in to continue.", 401);
  }
  // Proxies can answer with HTML or an empty body, such as during a restart.
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {}
  if (response.ok && result !== undefined) return result as T;
  const message = (result as { error?: unknown } | null | undefined)?.error;
  throw new ApiError(
    typeof message === "string" && message
      ? message
      : response.ok || response.status >= 500
        ? unavailable
        : "Request failed. Please try again.",
    response.status,
  );
}

export function useInteractive() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready;
}

export function dateLabel(
  value: string,
  interactive: boolean,
  options: Intl.DateTimeFormatOptions | "relative" = {},
) {
  const date = new Date(value);
  // Even with en-US and UTC, locale punctuation differs between runtimes, and
  // relative times depend on the reader's clock. Use ISO fields for
  // hydration, then localize once the client is ready.
  if (!interactive) {
    if (Number.isNaN(date.getTime())) return "Invalid Date";
    const iso = date.toISOString();
    return options !== "relative" && (options.hour || options.minute)
      ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
      : iso.slice(0, 10);
  }
  if (options === "relative") return relativeTime(value, Date.now());
  return date.toLocaleDateString("en-US", options);
}

const minute = 60_000,
  hour = 60 * minute,
  day = 24 * hour,
  week = 7 * day;
// Feed entries, comments, and notifications share one format: "now", "5m",
// "2h", or "3d" under a week, then "Oct 12", with the year when it is not the
// reader's current year. Elapsed time ignores daylight saving changes, and a
// reader's clock running behind shows new activity as now. `timeZone`
// defaults to the reader's own.
export function relativeTime(value: string, now: number, timeZone?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid Date";
  const elapsed = now - date.getTime();
  if (elapsed > -week && elapsed < week) {
    if (elapsed < minute) return "now";
    if (elapsed < hour) return `${Math.floor(elapsed / minute)}m`;
    if (elapsed < day) return `${Math.floor(elapsed / hour)}h`;
    return `${Math.floor(elapsed / day)}d`;
  }
  const year = (time: Date) =>
    time.toLocaleDateString("en-US", { year: "numeric", timeZone });
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: year(date) === year(new Date(now)) ? undefined : "numeric",
    timeZone,
  });
}
