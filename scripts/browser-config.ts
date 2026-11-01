import {
  checkoutDatabase,
  checkoutIdentity,
  checkoutRoot,
  testDatabaseURL,
} from "./checkout";

const mode = process.env.SCREENR_BROWSER_MODE ?? "production";
if (mode !== "production" && mode !== "development")
  throw new Error("SCREENR_BROWSER_MODE must be production or development.");
const port = Number(
  process.env.SCREENR_BROWSER_PORT ??
    20_000 + (parseInt(checkoutIdentity.slice(0, 8), 16) % 10_000) * 4,
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
} as const;
