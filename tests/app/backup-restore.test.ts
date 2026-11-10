import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { useDatabase, setup, db, testDatabaseURL } from "./social-fixture";
import { hang } from "./process-waits";
useDatabase();

// A real backup and restore check against the test server
// (docs/deployment.md#encrypted-backups-and-restore-check). ops/backup.sh
// dumps the test database and ops/restore-check.sh restores it into a scratch
// database with their own PostgreSQL commands and flags, so a schema or flag
// change that breaks restoring fails here before the weekly production check.
// tests/test_restore_check.py covers their storage retries, failures, and
// stops with fake commands. Here restic, the backup age check, and the host's
// paths and connection are the boundary. Production restores as the
// non-superuser screenr role, which is the test server's superuser, so this
// cannot catch a restore that needs more privilege than that role has.

const execute = promisify(execFile);

const wrapper = `
fixture() {
    case $1 in
    /var/lib/screenr-backup/*) printf '%s\\n' "$FIXTURE/\${1#/var/lib/screenr-backup/}" ;;
    *) printf '%s\\n' "$1" ;;
    esac
}
on_test_server() {
    tool=$1
    shift
    PGHOST=$TEST_PGHOST PGPORT=$TEST_PGPORT PGUSER=$TEST_PGUSER PGPASSWORD=$TEST_PGPASSWORD \\
        "$PG_BIN/$tool" "$@"
}
# The backup dumps production's screenr database.
pg_dump() {
    for arg; do
        shift
        case $arg in
        --file=*) arg=--file=$(fixture "\${arg#--file=}") ;;
        screenr) arg=$SOURCE_DATABASE ;;
        esac
        set -- "$@" "$arg"
    done
    on_test_server pg_dump "$@"
}
pg_restore() { on_test_server pg_restore "$@"; }
psql() { on_test_server psql "$@"; }
createdb() { on_test_server createdb "$@"; }
dropdb() { on_test_server dropdb "$@"; }
mktemp() {
    for arg; do shift; set -- "$@" "$(fixture "$arg")"; done
    command mktemp "$@"
}
rm() {
    for arg; do shift; set -- "$@" "$(fixture "$arg")"; done
    command rm "$@"
}
# The repository keeps the one snapshot that the backup uploads.
restic() {
    for last; do :; done
    case $1 in
    backup) cp "$(fixture "$last")" "$FIXTURE/snapshot" ;;
    dump) cat "$FIXTURE/snapshot" ;;
    esac
}
python3() { [ "$1" = /usr/local/lib/screenr-deploy/check-backup-age.py ]; }
sleep() { echo "sleep $*" >&2; }
. "$SCRIPT"
`;

const directories: string[] = [];
after(() =>
  Promise.all(
    directories.map((path) => rm(path, { recursive: true, force: true })),
  ),
);

// Production runs PostgreSQL's client commands from the server's major
// release, where Debian installs them, and so does this test: from there,
// from Homebrew's formula for that release, or else from PATH.
async function clientCommands(major: string) {
  const onPath = (
    await execute("sh", ["-c", "command -v pg_dump || true"])
  ).stdout.trim();
  for (const directory of [
    `/usr/lib/postgresql/${major}/bin`,
    `${process.env.HOMEBREW_PREFIX || "/opt/homebrew"}/opt/postgresql@${major}/bin`,
    ...(onPath ? [dirname(onPath)] : []),
  ]) {
    const version = await execute(join(directory, "pg_dump"), [
      "--version",
    ]).then(
      ({ stdout }) => /\(PostgreSQL\) (\d+)/.exec(stdout)?.[1],
      () => undefined,
    );
    if (version === major) return directory;
  }
  throw new Error(
    `The backup round trip needs PostgreSQL ${major}'s pg_dump, pg_restore, psql, createdb, and dropdb, in /usr/lib/postgresql/${major}/bin, Homebrew's postgresql@${major}, or on PATH.`,
  );
}

test("a backup restores through the weekly restore check", async () => {
  await setup();
  const profiles = (
    await db.query("SELECT count(*)::int AS count FROM profile")
  ).rows[0].count;
  assert.ok(profiles > 0);
  const server = new URL(testDatabaseURL);
  const major = String(
    Math.floor(
      Number(
        (await db.query("SHOW server_version_num")).rows[0].server_version_num,
      ) / 10000,
    ),
  );
  const binaries = await clientCommands(major);
  const fixture = await mkdtemp(join(tmpdir(), "screenr-backup-"));
  directories.push(fixture);
  const run = (script: string) => {
    const result = execute("sh", ["-c", wrapper], {
      env: {
        ...process.env,
        SCRIPT: resolve(script),
        FIXTURE: fixture,
        PG_BIN: binaries,
        TEST_PGHOST: server.hostname,
        TEST_PGPORT: server.port || "5432",
        TEST_PGUSER: decodeURIComponent(server.username),
        TEST_PGPASSWORD: decodeURIComponent(server.password),
        SOURCE_DATABASE: server.pathname.slice(1),
      },
      // Dropping a database waits for a checkpoint, which can take many
      // seconds on a busy machine. Only a hang reaches this bound.
      timeout: hang,
    });
    return { result, pid: result.child.pid };
  };
  const databases = async (name: string) =>
    (
      await db.query(
        "SELECT count(*)::int AS count FROM pg_database WHERE datname=$1",
        [name],
      )
    ).rows[0].count;

  const backup = run("ops/backup.sh");
  await backup.result;
  assert.ok((await stat(join(fixture, "snapshot"))).size > 0);

  const restore = run("ops/restore-check.sh");
  // The restore check names its scratch database after its shell's process.
  const scratch = `screenr_restore_check_${restore.pid}`;
  try {
    const { stdout } = await restore.result;
    assert.match(stdout, new RegExp(`^Restored profiles: ${profiles}$`, "m"));
    assert.match(stdout, /restored_comments/);
    assert.match(stdout, /screenr_can_read/);
    assert.match(stdout, /Encrypted backup read and PostgreSQL restore passed/);
    // Both scripts remove their dumps, and the check drops its database.
    assert.deepEqual(await readdir(fixture), ["snapshot"]);
    assert.equal(await databases(scratch), 0);
  } finally {
    if (await databases(scratch))
      await db.query(`DROP DATABASE "${scratch}" WITH (FORCE)`);
  }
});
