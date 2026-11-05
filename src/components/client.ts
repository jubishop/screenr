"use client";
import { useSyncExternalStore } from "react";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import { loginPath, returnPath } from "../member-routes";
import type {
  ActionName,
  ActionResult,
  ReadAction,
  WriteAction,
} from "../server/actions";
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
// Repeating a read cannot fix a client error, such as a missing page, denied
// access, or an ended session. Timeouts (408), rate limits (429), server
// errors, and network failures can pass, so background reads keep retrying.
export function isPermanent(status: number | undefined) {
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}
// Every request, including Better Auth's, stops waiting here, so a stalled
// request releases its controls. Writes can wait on the catalog's
// eight-second timeout. Reads also pass shorter deadlines with their own
// messages.
const requestDeadline = 15_000;
// What a screen or notification read says when it passes its own
// ten-second deadline.
export const refreshTimedOut = "Refresh timed out. Please try again.";
const unavailable =
  "Screenr is temporarily unavailable. Please try again in a moment.";
// A signal that aborts with the first of `signals` to abort, and its reason.
// Safari before 17.4, a supported browser, has no AbortSignal.any
// (docs/interface-design.md#supported-browsers--2026-11-01).
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    // Aborting the controller removes every listener added here.
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      signal: controller.signal,
    });
  }
  return controller.signal;
}
// The deadline also covers the body, so the whole reply is read here.
async function send(input: string | URL | Request, init: RequestInit) {
  const deadline = AbortSignal.timeout(requestDeadline);
  const { signal } = init;
  try {
    const response = await fetch(input, {
      ...init,
      signal: signal ? anySignal([signal, deadline]) : deadline,
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
// Each action's address, with a read's query.
type Query = Record<string, string> | URLSearchParams;
function address(action: ActionName, query?: Query) {
  const search = new URLSearchParams(query).toString();
  return `/api/screenr/${action}${search ? `?${search}` : ""}`;
}

// Sends a write with its data: a Blob, such as a photo, as the raw request
// body, and other data as JSON.
export async function api<Name extends WriteAction>(
  action: Name,
  data: unknown,
  signal?: AbortSignal,
): Promise<ActionResult<Name>> {
  const { response, text } = await send(address(action), {
    method: "POST",
    cache: "no-store",
    signal,
    headers: {
      "Content-Type": data instanceof Blob ? data.type : "application/json",
    },
    body: data instanceof Blob ? data : JSON.stringify(data),
  });
  return readReply(response, text);
}

// Reads with the query in the address.
export async function read<Name extends ReadAction>(
  action: Name,
  query: Query,
  signal?: AbortSignal,
): Promise<ActionResult<Name>> {
  const { response, text } = await send(address(action, query), {
    cache: "no-store",
    signal,
  });
  return readReply(response, text);
}

// A repeated read sends the version of the copy it holds. An unchanged reply
// is 304 without a body and returns null; otherwise the read returns its data
// and new version.
export async function readChanged<Name extends ReadAction>(
  action: Name,
  query: Query,
  version: string | null,
  signal?: AbortSignal,
): Promise<{ data: ActionResult<Name>; version: string | null } | null> {
  const { response, text } = await send(address(action, query), {
    cache: "no-store",
    signal,
    headers: version ? { "If-None-Match": version } : {},
  });
  if (response.status === 304) return null;
  return {
    data: readReply(response, text),
    version: response.headers.get("ETag"),
  };
}

// The reply's JSON, which the caller types as its action's result.
function readReply<T>(response: Response, text: string): T {
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

// Drops results that a redirect left in the address, such as a failed Google
// connection's error, once the page shows them, so a reload doesn't show
// them again. The history entry keeps its state, which the router reads on
// Back and Forward.
export function forgetResults(...keys: string[]) {
  const url = new URL(window.location.href);
  for (const key of keys) url.searchParams.delete(key);
  if (url.href !== window.location.href)
    window.history.replaceState(window.history.state, "", url);
}

// False while the server renders and the browser hydrates its markup, then
// true. Hydration renders again once ready. A screen reached by client
// navigation is interactive from its first render, so it never shows the
// server's UTC dates or disabled controls.
const neverChanges = () => () => {};
export function useInteractive() {
  return useSyncExternalStore(
    neverChanges,
    () => true,
    () => false,
  );
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
  if (Number.isNaN(date.getTime())) return "Invalid Date";
  return dateFormat(options).format(date);
}

const minute = 60_000,
  hour = 60 * minute,
  day = 24 * hour,
  week = 7 * day;

// Building a date formatter takes far longer than formatting with one, and a
// feed can show thousands of dates, so dates with the same options share a
// formatter. Formatters keep the time zone they were built in, so they are
// built again when the reader's zone changes. Dates check the zone at most
// once a minute, and `readerCalendar` checks it on every call.
const formats = new Map<string, Intl.DateTimeFormat>();
let formatZone: string | undefined;
let zoneChecked = -Infinity;
function readerTimeZone(now: number) {
  zoneChecked = now;
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone !== formatZone) {
    formats.clear();
    formatZone = zone;
  }
  return zone;
}
function dateFormat(options: Intl.DateTimeFormatOptions) {
  const now = Date.now();
  if (!(Math.abs(now - zoneChecked) < minute)) readerTimeZone(now);
  const key = JSON.stringify(options);
  let format = formats.get(key);
  if (!format) {
    // Like toLocaleDateString, show the date when the options name no part
    // of it.
    const { weekday, year, month, day, dateStyle } = options;
    format = new Intl.DateTimeFormat(
      "en-US",
      weekday || year || month || day || dateStyle
        ? options
        : { ...options, year: "numeric", month: "numeric", day: "numeric" },
    );
    formats.set(key, format);
  }
  return format;
}

// The reader's time zone and current year, which together decide how a date
// a week or older reads.
export function readerCalendar() {
  const now = Date.now();
  return `${readerTimeZone(now)} ${dateFormat({ year: "numeric" }).format(now)}`;
}

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
  const year = dateFormat({ year: "numeric", timeZone });
  return dateFormat({
    month: "short",
    day: "numeric",
    year: year.format(date) === year.format(now) ? undefined : "numeric",
    timeZone,
  }).format(date);
}
