import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

// Every harness process and Playwright worker derives the same configuration
// from the checkout, including when the checkout is reached through a symlink.
const root = realpathSync(process.cwd());
const identity = createHash("sha256").update(root).digest("hex");
const port = Number(
  process.env.SCREENR_BROWSER_PORT ??
    20_000 + (parseInt(identity.slice(0, 8), 16) % 10_000) * 4,
);
if (!Number.isInteger(port) || port < 1024 || port > 65532)
  throw new Error(
    "SCREENR_BROWSER_PORT must be an integer from 1024 to 65532.",
  );
const database = new URL(
  process.env.TEST_DATABASE_URL ??
    "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test",
);
if (
  !["postgres:", "postgresql:"].includes(database.protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(database.hostname) ||
  database.search !== "" ||
  !/^\/[a-z0-9_]+_test$/.test(database.pathname)
)
  throw new Error("Browser tests require a loopback PostgreSQL test database.");
const databaseName =
  process.env.SCREENR_BROWSER_DATABASE ??
  `screenr_browser_${identity.slice(0, 12)}_test`;
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
  root,
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
};
