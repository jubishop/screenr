import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseError } from "pg";

const request = new AsyncLocalStorage<string>();

// Runs an API request. Failures logged while it runs name its request ID,
// which the response also carries, so a client's error report and the
// server's line can be matched: docs/data-and-access.md#client-headers
export function withRequestId<T>(requestId: string, run: () => T) {
  return request.run(requestId, run);
}

// Failures print one JSON line to standard error, which the journal keeps
// for screenr-web and screenr-worker. Error messages are left out: PostgreSQL
// and parser messages can quote the values that failed, and request or email
// content is private. Codes, schema names, and stack frames identify the
// failure without them. With SENTRY_DSN set, the same record also goes to
// Sentry. Its requestId, from withRequestId or the fields, becomes the
// report's request_id tag.
export function logFailure(
  event: string,
  fields: Record<string, string | number | boolean | undefined>,
  error?: unknown,
) {
  const record = {
    event,
    requestId: request.getStore(),
    ...fields,
    ...(error === undefined ? {} : describe(error, true)),
  };
  print(record);
  report(record);
}

function print(record: Record<string, unknown>) {
  console.error(JSON.stringify(record));
}

function describe(error: unknown, withStack: boolean): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: typeof error };
  const type = error.constructor.name;
  const code = (error as { code?: unknown }).code;
  return {
    error: type,
    // Distinguishes DOMExceptions such as TimeoutError. PostgreSQL errors are
    // named "error" and most others repeat their class.
    name:
      /^error$/i.test(error.name) || error.name === type
        ? undefined
        : error.name,
    // PostgreSQL SQLSTATE codes and Node system error codes.
    code:
      typeof code === "string" && /^\w{1,64}$/.test(code) ? code : undefined,
    ...(error instanceof DatabaseError && {
      constraint: error.constraint,
      table: error.table,
      column: error.column,
    }),
    ...(withStack && {
      stack: frames(error),
      cause:
        error.cause === undefined ? undefined : describe(error.cause, false),
    }),
  };
}

// V8 stacks begin with the error's name and message, which can span lines.
// Fetch failures have no frames; their cause names the network error.
function frames(error: Error) {
  const stack = error.stack ?? "";
  const start = error.message ? stack.indexOf(error.message) : -1;
  const lines = stack
    .slice(start < 0 ? 0 : start + error.message.length)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, 12);
  return lines.length ? lines : undefined;
}

// Sends the logged record to Sentry as an envelope over HTTPS, without an SDK.
// The event holds nothing else: the record's fields as the failure context,
// the error class as the exception type, and its stack frames. The log event
// stands in for the exception value, which would otherwise be the message.
// The caller never waits for the send, and a failed send only prints a line.
function report(record: Record<string, unknown>) {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;
  const target = endpoint(dsn);
  if (!target)
    return print({ event: "sentry report failed", reason: "invalid DSN" });
  const id = randomUUID().replaceAll("-", "");
  const envelope = [
    { event_id: id },
    { type: "event" },
    sentryEvent(id, record),
  ]
    .map((part) => JSON.stringify(part))
    .join("\n");
  send(target, envelope).catch((error) =>
    print({ event: "sentry report failed", ...describe(error, true) }),
  );
}

async function send(target: { url: string; key: string }, envelope: string) {
  const response = await fetch(target.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-sentry-envelope",
      "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=screenr/1`,
    },
    body: envelope,
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (!response.ok)
    print({ event: "sentry report failed", status: response.status });
}

// A DSN has the form https://<public key>@<host>[/<path>]/<project ID>.
function endpoint(dsn: string) {
  const url = URL.parse(dsn);
  const path = url?.pathname.match(/^(.*)\/(\d+)$/);
  if (!url?.username || !path) return undefined;
  return {
    url: `${url.origin}${path[1]}/api/${path[2]}/envelope/`,
    key: url.username,
  };
}

function sentryEvent(id: string, record: Record<string, unknown>) {
  const { stack, ...fields } = record;
  const requestId = fields.requestId;
  return {
    event_id: id,
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    environment: process.env.NODE_ENV ?? "development",
    exception: {
      values: [
        {
          type: String(fields.error ?? fields.event),
          value: fields.error === undefined ? undefined : fields.event,
          mechanism: { type: "generic", handled: true },
          stacktrace: Array.isArray(stack)
            ? { frames: stack.map(sentryFrame).reverse() }
            : undefined,
        },
      ],
    },
    tags: {
      event: fields.event,
      request_id:
        typeof requestId === "string" ? requestId.slice(0, 200) : undefined,
    },
    contexts: { failure: fields },
  };
}

// Frames read "at <function> (<location>:<line>:<column>)" or
// "at <location>:<line>:<column>". Paths inside the release become relative,
// so the same frame matches across releases.
function sentryFrame(line: string) {
  const match = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
  if (!match) return { function: line.slice(3), in_app: false };
  const [, name, location, lineno, colno] = match;
  const path = location.startsWith("file:")
    ? fileURLToPath(location)
    : location;
  const root = process.cwd() + "/";
  return {
    function: name,
    filename: path.startsWith(root) ? path.slice(root.length) : path,
    abs_path: path,
    lineno: Number(lineno),
    colno: Number(colno),
    in_app: !path.startsWith("node:") && !path.includes("/node_modules/"),
  };
}
