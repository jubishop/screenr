import {
  test as base,
  type BrowserContext,
  type Request,
} from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readTransport, scriptPath } from "./browser-transport";

export const test = base.extend<{
  expectedScriptFailures: string[];
  scriptGuard: void;
}>({
  expectedScriptFailures: [[], { option: true }],
  scriptGuard: [
    async ({ browser, baseURL, expectedScriptFailures }, use, testInfo) => {
      const contexts = new Set<BrowserContext>();
      const closing = new WeakSet<BrowserContext>();
      let failure: Promise<void> | undefined;
      let reason: string | undefined;
      let stopping = false;
      const createContext = browser.newContext;
      const port = new URL(baseURL!).port;
      function failed(request: Request, error: string) {
        let url: URL;
        try {
          url = new URL(request.url());
        } catch {
          return;
        }
        const path = scriptPath(url.pathname);
        if (
          stopping ||
          failure ||
          !path ||
          request.method() !== "GET" ||
          request.resourceType() !== "script" ||
          url.protocol !== "http:" ||
          url.port !== port ||
          !["localhost", "127.0.0.1"].includes(url.hostname) ||
          error === "net::ERR_ABORTED" ||
          expectedScriptFailures.includes(path)
        )
          return;
        const file = testInfo.outputPath("script-failure.json");
        reason = `Essential local script failed: ${error} (${path}). Evidence: ${file}`;
        failure = (async () => {
          const evidence = {
            path,
            error,
            observedAt: new Date().toISOString(),
            startedAt: request.timing().startTime,
            originalTransport: await readTransport(Number(port)),
          };
          try {
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, JSON.stringify(evidence, null, 2), {
              mode: 0o600,
            });
            testInfo.attachments.push({
              name: "script-failure",
              path: file,
              contentType: "application/json",
            });
          } finally {
            await Promise.all(
              [...contexts].map((context) =>
                context.close({ reason }).catch(() => {}),
              ),
            );
          }
        })();
        // The fixture rethrows this after cleanup; never leak an unhandled rejection.
        void failure.catch(() => {});
      }
      browser.newContext = async function (...args) {
        const context = await Reflect.apply(createContext, this, args);
        contexts.add(context);
        const close = context.close;
        context.close = function (...args) {
          closing.add(context);
          return Reflect.apply(close, this, args);
        };
        context.on("requestfailed", (request) => {
          if (!closing.has(context))
            failed(
              request,
              request.failure()?.errorText ?? "Unknown transport error",
            );
        });
        context.on("response", (response) => {
          if (!closing.has(context) && response.status() >= 400)
            failed(response.request(), `HTTP ${response.status()}`);
        });
        context.once("close", () => contexts.delete(context));
        return context;
      };
      try {
        await use();
      } finally {
        stopping = true;
        browser.newContext = createContext;
        await failure;
        if (reason) throw new Error(reason);
      }
    },
    { auto: true },
  ],
});
