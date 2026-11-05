import { stripVTControlCharacters } from "node:util";

// A structured failure line is the one-line JSON object with an "event" field
// that logFailure in src/server/log.ts prints. Returns its record, or
// undefined for any other output. Test runs flag the lines no test expects:
// docs/testing.md#failure-lines
export function failureRecord(line: string) {
  if (!line.startsWith("{")) return undefined;
  try {
    const record: unknown = JSON.parse(line);
    return typeof (record as { event?: unknown })?.event === "string"
      ? (record as { event: string } & Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

// Better Auth's own unstructured line, such as
// `WARN [Better Auth]: Invalid id token`, as betterAuthLog in
// src/server/auth.ts prints it, or with a time and colors as Better Auth's
// default logger prints it outside a request. Application test runs flag the
// ones no test expects too.
export function betterAuthLine(line: string) {
  return /^(?:\S+ )?[A-Z]+ \[Better Auth\]: /.test(
    stripVTControlCharacters(line),
  );
}
