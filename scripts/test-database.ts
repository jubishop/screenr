import { Pool } from "pg";
const url = new URL(
  process.env.TEST_DATABASE_URL ??
    "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test",
);
const name = url.pathname.slice(1);
if (!/^[a-z0-9_]+_test$/.test(name))
  throw new Error("Use a dedicated database name ending in _test.");
url.pathname = "/postgres";
const admin = new Pool({ connectionString: url.href });
try {
  if (
    !(await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]))
      .rowCount
  )
    await admin.query(`CREATE DATABASE "${name}"`);
} finally {
  await admin.end();
}
