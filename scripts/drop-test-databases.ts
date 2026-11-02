import { Client } from "pg";
import { dropClaimedDatabases } from "./checkout";

// prepareTestDatabase in scripts/checkout.ts starts this detached, with the
// test server's connection in the PG environment variables, so no test start
// waits for a drop.
const admin = new Client();
await admin.connect();
try {
  await dropClaimedDatabases(admin);
} finally {
  await admin.end();
}
