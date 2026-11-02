import type { Instrumentation } from "next";
import { errorFields, logFailure } from "./server/log";

// In production, Next prints each error that reaches onRequestError below,
// message and properties such as PostgreSQL's detail included, just before it
// calls the hook, and its standalone server has no setting that stops it
// (issue #428). So console.error prints an Error argument as only the fields
// logFailure keeps, which also covers any library that prints an error
// object. Text, such as a message passed as a string, still prints as it is.
// Development keeps whole errors for debugging.
export function register() {
  if (process.env.NODE_ENV !== "production") return;
  const print = console.error;
  console.error = (...args: unknown[]) =>
    print.apply(
      console,
      args.map((arg) => (arg instanceof Error ? errorFields(arg) : arg)),
    );
}

// Next calls this for an error that escapes a page render, a route handler,
// or the proxy, such as a failed session read on a member page or a failure
// in the photo route. Handlers that catch their own failures, such as the
// /api/screenr route and the member page's first screen, never reach it.
// The line names the route pattern, such as /api/photos/[user]/[version],
// never the requested path, which can name people or search terms.
//
// In production, Next hands a failed page render's error to the hook twice:
// when the render throws it, and again, as the same object, when it crosses a
// React server boundary carrying its digest (issue #453). So each error object
// logs once. A separate failure is another object and logs its own line, even
// when every field matches.
const logged = new WeakSet<object>();
export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
  context,
) => {
  if (typeof error === "object" && error !== null) {
    if (logged.has(error)) return;
    logged.add(error);
  }
  logFailure(
    "route failed",
    {
      route: context.routePath,
      type: context.routeType,
      method: request.method,
    },
    error,
  );
};
