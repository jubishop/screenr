import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { Reporter, TestCase, TestResult } from "@playwright/test/reporter";

const require = createRequire(import.meta.url);

// Runs after each failure while the webServer fixture is still available.
// Trace parsing covers every context, including browser.newContext() calls.
export default class BrowserDiagnosticsReporter implements Reporter {
  constructor(private ports: { proxyPort: number; appPort: number }) {}

  printsToStdio() {
    return false;
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!["failed", "timedOut", "interrupted"].includes(result.status)) return;
    const traces = result.attachments
      .filter((attachment) => attachment.name === "trace" && attachment.path)
      .map((attachment) => attachment.path!);
    const directory = traces.length
      ? dirname(traces[0])
      : join(test.parent.project()!.outputDir, `${test.id}-${result.retry}`);
    const path = join(directory, "script-diagnostics.json");
    try {
      mkdirSync(directory, { recursive: true });
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
      writeFileSync(path, report, { mode: 0o600 });
      result.attachments.push({
        name: "script-diagnostics",
        path,
        contentType: "application/json",
      });
    } catch (error) {
      // A diagnostics failure must never replace the original test failure.
      const message = String(error).slice(0, 2000);
      console.error(`Browser script diagnostics unavailable: ${message}`);
      writeFileSync(path, JSON.stringify({ diagnosticError: message }), {
        mode: 0o600,
      });
    }
  }
}
