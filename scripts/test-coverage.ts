import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { testTimeout } from "../tests/app/process-waits";

// Runs application tests with Node's built-in coverage, reporting line,
// branch, and function coverage for src/ files the tests load. Pass test
// files to measure one suite; the default is every application test. Each
// test file runs under the same guards and test timeout as in npm test.
const files = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--import",
    "./tests/app/failure-guard.ts",
    "--import",
    "./tests/app/exit-guard.ts",
    "--enable-source-maps",
    "--test",
    "--test-concurrency=1",
    `--test-timeout=${testTimeout}`,
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    ...(files.length ? files : globSync("tests/app/*.test.ts").sort()),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
