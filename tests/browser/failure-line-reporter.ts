import type {
  FullConfig,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { failureRecord } from "../../scripts/failure-lines";
import {
  expectedFailureLines,
  type ExpectedFailureLine,
} from "./expected-failure-lines";

// A line can print just after its test ends, such as for a request the page
// sent as it closed.
const slack = 1000;

// Fails a browser run on any failure line the application printed that
// expected-failure-lines.ts doesn't expect, naming its event and the specs
// that ran when it printed. browser-server writes each line to the capture
// file with the time it printed; this reads them once the run ends, after the
// server stops. docs/testing.md#failure-lines
export default class FailureLineReporter implements Reporter {
  // Playwright creates reporters before it starts the server, so a capture
  // file left by an earlier run holds only older lines.
  private started = Date.now();
  // Only a run with the web server has its lines to check.
  private checked = false;
  private testDir = "";
  private runs: { spec: string; start: number; end: number }[] = [];

  constructor(
    private options: { file: string; expected?: ExpectedFailureLine[] },
  ) {}

  onBegin(config: FullConfig) {
    this.checked = Boolean(config.webServer);
    this.testDir = config.projects[0]?.testDir ?? config.rootDir;
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const start = result.startTime.getTime();
    this.runs.push({
      spec: relative(this.testDir, test.location.file),
      start,
      end: start + result.duration + slack,
    });
  }

  async onEnd() {
    if (!this.checked) return;
    const expected = this.options.expected ?? expectedFailureLines;
    const unexpected: string[] = [];
    for (const { at, line } of await this.captured()) {
      const record = failureRecord(line);
      if (!record || at < this.started) continue;
      const specs = [
        ...new Set(
          this.runs
            .filter((run) => run.start <= at && at <= run.end)
            .map((run) => run.spec),
        ),
      ];
      const known = expected.some(
        (entry) =>
          entry.specs.some((spec) => specs.includes(spec)) &&
          Object.entries(entry.fields).every(
            ([name, value]) => record[name] === value,
          ),
      );
      if (!known)
        unexpected.push(
          `${record.event}, while ${specs.join(" or ") || "no test"} ran: ${line}`,
        );
    }
    if (!unexpected.length) return;
    console.error(
      `\nThe application printed failure lines that no browser spec expects. Fix each failure, or, for one a spec causes on purpose, add it to tests/browser/expected-failure-lines.ts:\n${unexpected.map((entry) => `- ${entry}`).join("\n")}\n`,
    );
    return { status: "failed" as const };
  }

  private async captured(): Promise<{ at: number; line: string }[]> {
    let text;
    try {
      text = await readFile(this.options.file, "utf8");
    } catch (error) {
      // A run that never started the server printed nothing.
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    return text
      .split("\n")
      .filter(Boolean)
      .map((entry) => JSON.parse(entry));
  }
}
