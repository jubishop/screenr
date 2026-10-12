import {
  test as base,
  type BrowserContext,
  type Request,
} from "@playwright/test";

// Returns the path of an essential Next script, never an encoded traversal.
function scriptPath(value: string) {
  try {
    if (!/^\/_next\/static\/[A-Za-z0-9_./%~@+\[\]-]+\.js$/.test(value)) return;
    const decoded = decodeURIComponent(value);
    if (
      decoded.includes("\\") ||
      decoded.split("/").some((p) => p === "." || p === "..")
    )
      return;
    return value.slice(0, 1024);
  } catch {
    return;
  }
}

// A failed local script closes the test's contexts with the browser error, so
// actions stop promptly; Playwright keeps the failure trace. Any browser report
// of a Content-Security-Policy or Permissions-Policy problem fails the test.
export const test = base.extend<{
  expectedScriptFailures: string[];
  scriptGuard: void;
}>({
  expectedScriptFailures: [[], { option: true }],
  scriptGuard: [
    async ({ browser, baseURL, expectedScriptFailures }, use) => {
      const contexts = new Set<BrowserContext>();
      const closing = new WeakSet<BrowserContext>();
      let failure: Promise<unknown> | undefined;
      let reason: string | undefined;
      let stopping = false;
      const policyReports: string[] = [];
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
        reason = `Essential local script failed: ${error} (${path})`;
        failure = Promise.all(
          [...contexts].map((context) =>
            context.close({ reason }).catch(() => {}),
          ),
        );
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
        context.on("console", (message) => {
          if (
            ["error", "warning"].includes(message.type()) &&
            /content security policy|permissions.policy/i.test(message.text())
          )
            policyReports.push(`Browser policy report: ${message.text()}`);
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
        if (policyReports.length) throw new Error(policyReports.join("\n"));
      }
    },
    { auto: true },
  ],
});
