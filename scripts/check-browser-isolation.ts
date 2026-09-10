import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import type { browserConfig } from "./browser-config";
import { retainBrowserEvidence } from "./browser-evidence";

const execute = promisify(execFile);
const source = process.cwd();
const directory = await mkdtemp(join(tmpdir(), "screenr-browser-isolation-"));
const checkouts = [join(directory, "first"), join(directory, "second")];
const env = { ...process.env };
env.SCREENR_BROWSER_EVIDENCE_DIR = join(source, ".cache/browser-failures");
await retainBrowserEvidence(undefined, env.SCREENR_BROWSER_EVIDENCE_DIR);
const args = process.argv.slice(2);
const phases = args.includes("--warm") ? ["fresh", "warm"] : ["fresh"];
const browserArgs = args.filter((arg) => arg !== "--warm");
delete env.SCREENR_BROWSER_PORT;
delete env.SCREENR_BROWSER_DATABASE;
const configurations: (typeof browserConfig)[] = [];
let passed = false;
try {
  // Copy the current working files, including an uncommitted fix, but never
  // private environment files, generated output, or Git/worktree metadata.
  const { stdout } = await execute("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const files = [...new Set(stdout.split("\0").filter(Boolean))];
  for (const checkout of checkouts) {
    await mkdir(checkout, { recursive: true });
    for (const file of files) {
      const target = join(checkout, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(source, file), target);
    }
    // A real local dependency directory lets Next keep its filesystem root
    // inside this checkout. Copy-on-write is used where the filesystem supports it.
    await cp(join(source, "node_modules"), join(checkout, "node_modules"), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
    const result = await execute(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'import { browserConfig } from "./scripts/browser-config.ts"; console.log(JSON.stringify(browserConfig));',
      ],
      { cwd: checkout, env },
    );
    configurations.push(JSON.parse(result.stdout));
  }
  assert.notEqual(
    configurations[0].databaseName,
    configurations[1].databaseName,
  );
  const ports = configurations.flatMap((config) => [
    config.port,
    config.catalogPort,
    config.googlePort,
    config.appPort,
  ]);
  assert.equal(
    new Set(ports).size,
    8,
    "Default port ranges collided; rerun the check.",
  );
  async function checkActiveLocks() {
    const first = configurations[0];
    let ready = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        ready = (
          await fetch(`${first.baseURL}/api/health`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        /* The browser server has not started listening yet. */
      }
      if (ready) break;
      await delay(500);
    }
    assert.ok(ready, "First browser fixture did not become healthy.");
    const contender = join(directory, "contender");
    await mkdir(contender);
    // Use a third checkout path and a different port range to reach the
    // database guard, then the original checkout to reach its capture-file guard.
    for (const [cwd, database, resource] of [
      [contender, first.databaseName, "database"],
      [checkouts[0], "screenr_browser_unused_contender_test", "checkout"],
    ]) {
      await assert.rejects(
        execute(
          process.execPath,
          [
            "--import",
            join(source, "node_modules/tsx/dist/loader.mjs"),
            join(source, "scripts/browser-server.ts"),
          ],
          {
            cwd,
            env: {
              ...env,
              SCREENR_BROWSER_PORT: String(first.port + 8),
              SCREENR_BROWSER_DATABASE: database,
            },
            timeout: 15_000,
          },
        ),
        new RegExp(`Browser fixture ${resource}:.* is already in use`),
      );
    }
    console.log(
      "Active database and checkout conflicts were rejected before fixture reset.",
    );
  }
  const results = await Promise.allSettled([
    checkActiveLocks(),
    ...checkouts.map(async (checkout, index) => {
      const config = configurations[index];
      console.log(
        `Starting ${checkout}: ${config.baseURL}, ${config.databaseName}`,
      );
      try {
        for (const phase of phases) {
          const result = await execute(
            process.execPath,
            ["node_modules/@playwright/test/cli.js", "test", ...browserArgs],
            {
              cwd: checkout,
              env,
              timeout: 600_000,
              maxBuffer: 10 * 1024 * 1024,
            },
          );
          await writeFile(
            join(checkout, `browser-${phase}.log`),
            result.stdout + result.stderr,
          );
          assert.equal(
            await realpath(join(checkout, ".next")),
            join(await realpath(checkout), ".next"),
            "Build output must stay inside its owning checkout.",
          );
          if (config.mode === "production") {
            const buildID = (
              await readFile(join(checkout, ".next/BUILD_ID"), "utf8")
            ).trim();
            assert.ok(buildID, "Each checkout must produce a build artifact.");
            console.log(`${checkout} (${phase}) production build: ${buildID}`);
          }
          console.log(
            `${checkout} (${phase}): ${result.stdout.match(/\d+ passed[^\n]*/)?.[0] ?? "passed"}`,
          );
        }
      } catch (error) {
        const output = error as Error & { stdout?: string; stderr?: string };
        await writeFile(
          join(checkout, "browser.log"),
          `${output.stdout ?? ""}${output.stderr ?? ""}`,
        );
        throw error;
      }
    }),
  ]);
  assert.ok(
    results.every((result) => result.status === "fulfilled"),
    `Browser isolation failed: ${results
      .filter((result) => result.status === "rejected")
      .map((result) => String(result.reason))
      .join("; ")}. Inspect ${directory}/*/browser.log`,
  );
  // Invitations now belong to individual tests, rather than shared files.
  // Read both databases and verify that neither contains the other's tokens.
  // Complete signup journeys also consume each checkout's local email captures.
  const invitations = await Promise.all(
    configurations.map(async (config) => {
      const client = new Client({ connectionString: config.databaseURL });
      try {
        await client.connect();
        const { rows } = await client.query<{ token_hash: string }>(
          "SELECT token_hash FROM invitation",
        );
        assert.ok(
          rows.length,
          "The isolation check requires invitation coverage.",
        );
        return new Set(rows.map((row) => row.token_hash));
      } finally {
        await client.end();
      }
    }),
  );
  assert.ok(
    [...invitations[0]].every((token) => !invitations[1].has(token)),
    "Concurrent checkouts must not share invitation data.",
  );
  console.log(
    "Both concurrent browser suites passed with separate build output, ports, databases, and capture files.",
  );
  passed = true;
} finally {
  // Only these newly created disposable checkout databases are removed. Leave
  // failed checkout files and logs available for diagnosis.
  for (const config of configurations) {
    const url = new URL(config.databaseURL);
    url.pathname = "/postgres";
    const admin = new Client({ connectionString: url.href });
    try {
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS "${config.databaseName}"`);
    } finally {
      await admin.end();
    }
  }
  if (passed) await rm(directory, { recursive: true, force: true });
  else console.error(`Isolation check files retained at ${directory}`);
}
