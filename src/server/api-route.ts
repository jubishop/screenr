import { randomUUID } from "node:crypto";
import { withRequestId } from "./log";
import type { UsageClient } from "./usage";

// The client headers of /api/screenr and /api/photos requests:
// docs/data-and-access.md#client-headers
const iosClient = /^ios\/[\w.-]+\/(\d{1,15})$/;
const requestIdFormat = /^[\w-]{1,64}$/;

// Wraps a route handler. A request whose Screenr-Client header names an
// iPhone app build below SCREENR_IOS_MINIMUM_BUILD gets 426 before any other
// check; requests without that header, such as the web's, are never gated.
// Every response carries the request's Screenr-Request-Id.
export function apiRoute<Context>(
  handler: (request: Request, context: Context) => Promise<Response>,
) {
  return async (request: Request, context: Context) => {
    const sent = request.headers.get("Screenr-Request-Id");
    const requestId = sent && requestIdFormat.test(sent) ? sent : randomUUID();
    const response =
      checkClient(request) ??
      (await withRequestId(requestId, () => handler(request, context)));
    response.headers.set("Screenr-Request-Id", requestId);
    return response;
  };
}

// The client that sent a request, for usage telemetry: the iPhone app names
// itself in Screenr-Client, and the website sends no such header.
export function requestClient(headers: Headers): UsageClient {
  return iosClient.test(headers.get("Screenr-Client") ?? "") ? "ios" : "web";
}

function checkClient(request: Request) {
  const client = request.headers.get("Screenr-Client");
  if (client === null) return;
  const build = iosClient.exec(client)?.[1];
  if (!build) return reply({ error: "Invalid client header." }, 400);
  const minimum = minimumBuild();
  if (Number(build) < minimum)
    return reply(
      { error: "Update Screenr to continue.", minimumBuild: minimum },
      426,
    );
}

// Unset, empty, or malformed means no minimum. Deployment rejects a
// malformed value (scripts/validate-config.ts).
function minimumBuild() {
  const value = process.env.SCREENR_IOS_MINIMUM_BUILD?.trim() ?? "";
  return /^\d{1,15}$/.test(value) ? Number(value) : 0;
}

const reply = (data: unknown, status: number) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
