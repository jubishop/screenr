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
