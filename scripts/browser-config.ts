import {
  checkoutDatabase,
  checkoutIdentity,
  checkoutRoot,
  testDatabaseURL,
} from "./checkout";

const mode = process.env.SCREENR_BROWSER_MODE ?? "production";
if (mode !== "production" && mode !== "development")
  throw new Error("SCREENR_BROWSER_MODE must be production or development.");
// The derived four-port block lies from 12288 through 32767. Linux assigns
// outbound source ports and port-0 listeners from 32768 through 60999 by
// default, and macOS from 49152 through 65535, so another socket could hold
// a fixture port there when the harness reserves it or its server listens
// (#490). Busy local services, such as Ollama on 11434, sit below 12288.
const port = Number(
  process.env.SCREENR_BROWSER_PORT ??
    12_288 + (parseInt(checkoutIdentity.slice(0, 8), 16) % 5_120) * 4,
);
if (!Number.isInteger(port) || port < 1024 || port > 65532)
  throw new Error(
    "SCREENR_BROWSER_PORT must be an integer from 1024 to 65532.",
  );
// The browser database shares the application test database's server and
// credentials.
const database = new URL(testDatabaseURL);
if (
  !["postgres:", "postgresql:"].includes(database.protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
  database.search !== "" ||
  !/^\/[a-z0-9_]+_test$/.test(database.pathname)
)
  throw new Error("Browser tests require a loopback PostgreSQL test database.");
const databaseName =
  process.env.SCREENR_BROWSER_DATABASE ?? checkoutDatabase("browser");
if (
  !/^screenr_browser_[a-z0-9_]+_test$/.test(databaseName) ||
  databaseName.length > 63 ||
  `/${databaseName}` === database.pathname
)
  throw new Error(
    "SCREENR_BROWSER_DATABASE must be a separate database named screenr_browser_<name>_test (at most 63 characters).",
  );
database.pathname = `/${databaseName}`;

export const browserConfig = {
  root: checkoutRoot,
  mode,
  port,
  catalogPort: port + 1,
  googlePort: port + 2,
  appPort: port + 3,
  // Match the IPv4-only listeners. An IPv6 localhost connection can connect
  // to itself when its ephemeral source port equals the unbound target port.
  baseURL: `http://127.0.0.1:${port}`,
  catalogURL: `http://127.0.0.1:${port + 1}`,
  googleURL: `http://127.0.0.1:${port + 2}`,
  // Next's development image metadata uses localhost regardless of its bind address.
  appURL: `http://localhost:${port + 3}`,
  databaseName,
  databaseURL: database.href,
  // The application's failure lines during a run, which browser-server writes
  // and the failure line reporter checks once the run ends.
  failureLines: `${checkoutRoot}/.cache/browser-failure-lines.jsonl`,
} as const;
