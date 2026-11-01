import { Client } from "pg";
import { prepareTestDatabase, testDatabaseURL } from "./checkout";

const url = new URL(testDatabaseURL);
const name = url.pathname.slice(1);
if (!/^[a-z0-9_]+_test$/.test(name))
  throw new Error("Use a dedicated database name ending in _test.");
url.pathname = "/postgres";
// One connection keeps the preparation lock for its whole session.
const admin = new Client({ connectionString: url.href });
await admin.connect();
try {
  await prepareTestDatabase(admin, name);
} finally {
  await admin.end();
}
