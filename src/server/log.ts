import { DatabaseError } from "pg";

// Failures print one JSON line to standard error, which the journal keeps
// for screenr-web and screenr-worker. Error messages are left out: PostgreSQL
// and parser messages can quote the values that failed, and request or email
// content is private. Codes, schema names, and stack frames identify the
// failure without them.
export function logFailure(
  event: string,
  fields: Record<string, string | number | boolean | undefined>,
  error?: unknown,
) {
  console.error(
    JSON.stringify({
      event,
      ...fields,
      ...(error === undefined ? {} : describe(error, true)),
    }),
  );
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
