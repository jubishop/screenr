import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ParserOptions } from "prettier";
import { parsers } from "prettier/plugins/typescript";
import { hang } from "./process-waits";

// Application tests wait for their processes under one bound that only a hang
// reaches.

// Bounds that a test checks on purpose, as "file: name". Each file says beside
// its bound why it must stay tight.
const deliberate = new Set(["operations.test.ts: activationBound"]);

// node:child_process functions that start a process and take a timeout.
const starts = new Set([
  "exec",
  "execFile",
  "execFileSync",
  "execSync",
  "fork",
  "spawn",
  "spawnSync",
]);

// A node of the ESTree syntax tree that Prettier's TypeScript parser returns.
type Node = { type: string; [field: string]: any };

function* walk(node: Node): Generator<Node> {
  yield node;
  for (const [field, value] of Object.entries(node)) {
    if (["loc", "range", "tokens", "comments"].includes(field)) continue;
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child.type === "string") yield* walk(child);
  }
}

const name = (node: Node) =>
  node.type === "Identifier" ? node.name : node.value;

// Returns each `timeout` that a call passes to a process it starts, with the
// source of the bound and whether it is the shared hang bound.
async function processWaits(source: string) {
  const program: Node = await parsers.typescript.parse(
    source,
    {} as ParserOptions,
  );
  const nodes = [...walk(program)];
  // Local names of the functions that start processes, of the modules that
  // hold them, and of the shared bound.
  const starters = new Set<string>();
  const modules = new Set<string>();
  const shared = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "ImportDeclaration") continue;
    for (const specifier of node.specifiers)
      if (/^(node:)?child_process$/.test(node.source.value)) {
        if (specifier.type !== "ImportSpecifier")
          modules.add(specifier.local.name);
        else if (starts.has(name(specifier.imported)))
          starters.add(specifier.local.name);
      } else if (
        node.source.value === "./process-waits" &&
        specifier.type === "ImportSpecifier" &&
        name(specifier.imported) === "hang"
      )
        shared.add(specifier.local.name);
  }
  const starter = (node: Node): boolean =>
    (node.type === "Identifier" && starters.has(node.name)) ||
    (node.type === "MemberExpression" &&
      node.object.type === "Identifier" &&
      modules.has(node.object.name) &&
      starts.has(name(node.property))) ||
    // promisify(execFile), as a call or a name bound to one.
    (node.type === "CallExpression" &&
      name(
        node.callee.type === "MemberExpression"
          ? node.callee.property
          : node.callee,
      ) === "promisify" &&
      node.arguments.length === 1 &&
      starter(node.arguments[0]));
  for (let added = true; added;) {
    added = false;
    for (const node of nodes)
      if (
        node.type === "VariableDeclarator" &&
        node.id.type === "Identifier" &&
        node.init &&
        !starters.has(node.id.name) &&
        starter(node.init)
      ) {
        starters.add(node.id.name);
        added = true;
      }
  }
  const waits: { line: number; bound: string; shared: boolean }[] = [];
  for (const node of nodes) {
    if (node.type !== "CallExpression" || !starter(node.callee)) continue;
    for (const argument of node.arguments) {
      if (argument.type !== "ObjectExpression") continue;
      for (const property of argument.properties)
        if (property.type === "Property" && name(property.key) === "timeout")
          waits.push({
            line: property.loc.start.line,
            bound: source.slice(...(property.value.range as [number, number])),
            shared:
              property.value.type === "Identifier" &&
              shared.has(property.value.name),
          });
    }
  }
  return waits;
}

test("every process wait in the application tests uses the shared hang bound", async () => {
  // A bound sized for an idle Mac fails its test when parallel checks load it.
  const files = (await readdir("tests/app"))
    .filter((file) => file.endsWith(".ts"))
    .sort();
  let count = 0;
  const others: string[] = [];
  const kept = new Set<string>();
  for (const file of files)
    for (const { line, bound, shared } of await processWaits(
      await readFile(join("tests/app", file), "utf8"),
    )) {
      count++;
      if (deliberate.has(`${file}: ${bound}`)) kept.add(`${file}: ${bound}`);
      else if (!shared) others.push(`${file}:${line}: timeout: ${bound}`);
    }
  assert.ok(count > 0);
  assert.deepEqual(
    others,
    [],
    "Pass hang from tests/app/process-waits.ts as the timeout.",
  );
  assert.deepEqual([...kept].sort(), [...deliberate].sort());
});

test("the check finds the bound of every kind of process call", async () => {
  const source = `import { execFile as run, spawn, spawnSync } from "node:child_process";
import * as child from "node:child_process";
import { promisify } from "node:util";
import { hang } from "./process-waits";
const execute = promisify(run);
const npm = (...args: string[]) => execute("npm", args, { timeout: 5_000 });
await promisify(run)("node", [], { cwd: ".", timeout: hang });
spawn("caddy", ["run"], { timeout: limit });
spawnSync("git", [], { ...options, "timeout": 30 * 1000 });
child.execFileSync("tar", [], { timeout: 10_000 });
setTimeout(() => {}, 1000);
await fetch(url, { signal: AbortSignal.timeout(5000) });
test("name", { timeout: 10_000 }, () => {});
`;
  assert.deepEqual(await processWaits(source), [
    { line: 6, bound: "5_000", shared: false },
    { line: 7, bound: "hang", shared: true },
    { line: 8, bound: "limit", shared: false },
    { line: 9, bound: "30 * 1000", shared: false },
    { line: 10, bound: "10_000", shared: false },
  ]);
  // A bound of the same name that the file sets itself is not the shared one.
  assert.deepEqual(
    await processWaits(`import { execFile } from "child_process";
const hang = 1000;
execFile("node", [], { timeout: hang });
`),
    [{ line: 3, bound: "hang", shared: false }],
  );
});

test("a hung process fails its test before CI cancels the job", async () => {
  // The app jobs run the application tests. A shard takes under 4 minutes,
  // so one hang still ends its test, which reports what hung, within the
  // job's limit.
  const workflow = await readFile(".github/workflows/check.yml", "utf8");
  const job = /^ {2}app:\n(?:(?: {4}.*)?\n)*/m.exec(workflow)?.[0] ?? "";
  assert.match(job, /^ +run: bin\/check-application --part app\b/m);
  const limit = /^ {4}timeout-minutes: (\d+)$/m.exec(job);
  assert.ok(limit, job);
  assert.ok(hang <= Number(limit[1]) * 60_000 - 5 * 60_000);
});
