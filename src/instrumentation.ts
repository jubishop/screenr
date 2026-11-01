import type { Instrumentation } from "next";
import { logFailure } from "./server/log";

// Next calls this for an error that escapes a page render, a route handler,
// or the proxy, such as a failed session read on a member page or a failure
// in the photo route. Handlers that catch their own failures, such as the
// /api/screenr route and the member page's first screen, never reach it.
// The line names the route pattern, such as /api/photos/[user]/[version],
// never the requested path, which can name people or search terms.
export const onRequestError: Instrumentation.onRequestError = (
  error,
  request,
  context,
) => {
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
