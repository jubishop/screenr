import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import "./social-fixture";

const execute = promisify(execFile);

test("activation reaches rollback when its health request stalls", async () => {
  // System administration is the boundary: no real host paths or services change.
  // The fake HTTP command stalls unless a total deadline bounds the request.
  const result = await execute(
    "sh",
    [
      "-c",
      `
      test() { if [ "$1" = "-f" ]; then return 0; fi; command test "$@"; }
      # Activation runs its release scripts through the kit's sandboxed runner.
      sh() { [ "$1" = /usr/local/lib/screenr-deploy/run-release-script.sh ]; }
      mkdir() { :; }
      chown() { :; }
      readlink() { printf '/opt/screenr/releases/previous\\n'; }
      ln() { printf 'link %s %s\\n' "$2" "$3"; }
      mv() { :; }
      systemctl() { printf 'service %s\\n' "$*"; }
      sleep() { :; }
      curl() {
        while [ "$#" -gt 0 ]; do
          if [ "$1" = "--max-time" ] && [ "$2" -gt 0 ]; then return 28; fi
          shift
        done
        /bin/sleep 3
      }
      script=$1
      shift
      . "$script"
      `,
      "activation-fixture",
      resolve("ops/activate.sh"),
      "/opt/screenr/releases/candidate",
    ],
    { timeout: 1000 },
  ).then(
    () => assert.fail("A stalled health check must fail activation."),
    (
      error: Error & {
        code: number;
        killed: boolean;
        stdout: string;
        stderr: string;
      },
    ) => error,
  );
  assert.equal(
    result.killed,
    false,
    "Activation must reach its own failure path.",
  );
  // Every health request stalls, so the restored release fails its checks too.
  assert.equal(result.code, 69, result.stderr);
  assert.match(
    result.stdout,
    /link \/opt\/screenr\/releases\/previous \/opt\/screenr\/current.rollback/,
  );
  assert.match(result.stderr, /ROLLBACK FAILED: production is down\./);
});

test("migration rejects an invalid SQL filename before applying domain changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screenr-migration-"));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "db"));
    await cp("scripts/migrate.ts", join(directory, "scripts/migrate.ts"));
    await cp("src", join(directory, "src"), { recursive: true });
    await symlink(
      resolve("node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    // A valid pending migration must not run before the filename check.
    await writeFile(join(directory, "db/999-review-probe.sql"), "SELECT 1/0;");
    await writeFile(join(directory, "db/invalid.sql"), "SELECT 1;");
    // Each migration run inherits the test database and auth settings from the
    // shared fixture.
    const result = await execute(
      process.execPath,
      ["--import", "tsx", "scripts/migrate.ts"],
      {
        cwd: directory,
        timeout: 15000,
      },
    ).then(
      () => assert.fail("Invalid migration filenames must reject the release."),
      (error: Error & { stderr: string }) => error,
    );
    assert.match(result.stderr, /invalid.sql/);
    assert.doesNotMatch(result.stderr, /division by zero/);
    await rm(join(directory, "db/invalid.sql"));
    await rm(join(directory, "db/999-review-probe.sql"));
    const recovered = await execute(
      process.execPath,
      ["--import", "tsx", "scripts/migrate.ts"],
      {
        cwd: directory,
        timeout: 15000,
      },
    );
    assert.match(recovered.stdout, /Database migrations applied/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
