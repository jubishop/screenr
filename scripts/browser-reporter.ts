import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { readTransport } from "./browser-transport";
import { retainBrowserEvidence } from "./browser-evidence";

const require = createRequire(import.meta.url);

// Runs after each failure while the webServer fixture is still available.
// Trace parsing covers every context, including browser.newContext() calls.
export default class BrowserDiagnosticsReporter implements Reporter {
  private pending: Promise<void>[] = [];
  constructor(private ports: { proxyPort: number; appPort: number }) {}

  printsToStdio() {
    return false;
  }

  onBegin() {
    this.pending.push(
      retainBrowserEvidence().then(
        () => {},
        (error) => {
          console.error(
            `Browser evidence cleanup unavailable: ${String(error)}`,
          );
        },
      ),
    );
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!["failed", "timedOut", "interrupted"].includes(result.status)) return;
    this.pending.push(this.collect(test, result));
  }

  async onEnd() {
    await Promise.all(this.pending);
  }

  private async collect(test: TestCase, result: TestResult) {
    const traces = result.attachments
      .filter((attachment) => attachment.name === "trace" && attachment.path)
      .map((attachment) => attachment.path!);
    const directory = traces.length
      ? dirname(traces[0])
      : join(test.parent.project()!.outputDir, `${test.id}-${result.retry}`);
    const path = join(directory, "script-diagnostics.json");
    try {
      mkdirSync(directory, { recursive: true });
      const captured = result.attachments.find(
        (attachment) => attachment.name === "script-failure" && attachment.path,
      );
      const scriptFailure = captured
        ? JSON.parse(readFileSync(captured.path!, "utf8"))
        : undefined;
      const originalTransport =
        scriptFailure?.originalTransport ??
        (await readTransport(this.ports.proxyPort));
      const report = execFileSync(
        "python3",
        [fileURLToPath(new URL("./browser-diagnostics.py", import.meta.url))],
        {
          input: JSON.stringify({
            ...this.ports,
            traces,
            runtime: {
              node: process.version,
              platform: process.platform,
              arch: process.arch,
              playwright: require("@playwright/test/package.json").version,
              next: require("next/package.json").version,
            },
          }),
          timeout: 10_000,
          maxBuffer: 256 * 1024,
        },
      );
      const contents = JSON.stringify(
        {
          ...JSON.parse(report.toString()),
          scriptFailure: scriptFailure
            ? { ...scriptFailure, originalTransport: undefined }
            : undefined,
          originalTransport,
        },
        null,
        2,
      );
      writeFileSync(path, contents, { mode: 0o600 });
      const retained = await retainBrowserEvidence(contents);
      console.error(`Browser evidence retained: ${retained}`);
      result.attachments.push({
        name: "script-diagnostics",
        path,
        contentType: "application/json",
      });
    } catch (error) {
      // A diagnostics failure must never replace the original test failure.
      const message = String(error).slice(0, 2000);
      console.error(`Browser script diagnostics unavailable: ${message}`);
      if (!existsSync(path))
        writeFileSync(path, JSON.stringify({ diagnosticError: message }), {
          mode: 0o600,
        });
    }
  }
}
