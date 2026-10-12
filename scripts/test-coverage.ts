import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

// Runs application tests with Node's built-in coverage, reporting line,
// branch, and function coverage for src/ files the tests load. Pass test
// files to measure one suite; the default is every application test.
const files = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--enable-source-maps",
    "--test",
    "--test-concurrency=1",
    "--experimental-test-coverage",
    "--test-coverage-include=src/**",
    ...(files.length ? files : globSync("tests/app/*.test.ts").sort()),
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
