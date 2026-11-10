import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { ParserOptions } from "prettier";
import { parsers } from "prettier/plugins/typescript";
import { hang } from "./process-waits";

// Application tests wait for their processes, the database, and work in their
// own process under one bound that only a hang reaches. Polls that compare
// the time with a deadline are ordinary arithmetic, which this check can't
// tell from a timestamp, so memory/process-test-waits.md alone describes them.

// Bounds that a test checks on purpose, as "file: name". Each file says beside
// its bound why it must stay tight.
const deliberate = new Set([
  "email.test.ts: stopBound",
  "operations.test.ts: activationBound",
]);

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

// node:test functions, and the test context methods of the same names, whose
// options take a timeout.
const runners = new Set([
  "test",
  "it",
  "describe",
  "suite",
  "before",
  "after",
  "beforeEach",
  "afterEach",
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

type Wait = { line: number; kind: string; bound: string; shared: boolean };

// Returns the bound on each wait: the `timeout` that a call passes to a
// process it starts or to a test, the delay of a timer that races other work
// in Promise.race, and a request's timeout. Each comes with the source of the
// bound and whether it is the shared hang bound.
async function waits(source: string) {
  const program: Node = await parsers.typescript.parse(
    source,
    {} as ParserOptions,
  );
  const nodes = [...walk(program)];
  // Local names of the functions that start processes, of the modules that
  // hold them, of the shared bound, of node:test's functions, and of the
  // promise timer.
  const starters = new Set<string>();
  const modules = new Set<string>();
  const shared = new Set<string>();
  const tests = new Set<string>();
  const sleeps = new Set<string>();
  for (const node of nodes) {
    if (node.type !== "ImportDeclaration") continue;
    const from = node.source.value;
    for (const specifier of node.specifiers) {
      const imported =
        specifier.type === "ImportSpecifier"
          ? name(specifier.imported)
          : undefined;
      if (/^(node:)?child_process$/.test(from)) {
        if (imported === undefined) modules.add(specifier.local.name);
        else if (starts.has(imported)) starters.add(specifier.local.name);
      } else if (from === "./process-waits" && imported === "hang")
        shared.add(specifier.local.name);
      else if (
        from === "node:test" &&
        (specifier.type === "ImportDefaultSpecifier" ||
          (imported !== undefined && runners.has(imported)))
      )
        tests.add(specifier.local.name);
      else if (
        /^(node:)?timers\/promises$/.test(from) &&
        imported === "setTimeout"
      )
        sleeps.add(specifier.local.name);
    }
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
  const found = new Map<Node, Wait>();
  const record = (kind: string, bound: Node | undefined) => {
    if (bound && bound.type !== "SpreadElement")
      found.set(bound, {
        line: bound.loc.start.line,
        kind,
        bound: source.slice(...(bound.range as [number, number])),
        shared: bound.type === "Identifier" && shared.has(bound.name),
      });
  };
  // The `timeout` among a call's options.
  const option = (kind: string, call: Node) => {
    for (const argument of call.arguments)
      if (argument.type === "ObjectExpression")
        for (const property of argument.properties)
          if (property.type === "Property" && name(property.key) === "timeout")
            record(kind, property.value);
  };
  for (const node of nodes) {
    if (node.type !== "CallExpression") continue;
    const { callee } = node;
    const method =
      callee.type === "MemberExpression" ? name(callee.property) : undefined;
    const on = method === undefined ? undefined : callee.object;
    if (starter(callee)) option("process timeout", node);
    else if (
      (callee.type === "Identifier" && tests.has(callee.name)) ||
      (method !== undefined && runners.has(method))
    )
      option("test timeout", node);
    // Playwright's request context.
    else if (method === "newContext") option("request timeout", node);
    else if (
      method === "race" &&
      on.type === "Identifier" &&
      on.name === "Promise"
    )
      for (const raced of node.arguments.flatMap((argument: Node) => [
        ...walk(argument),
      ]))
        if (
          raced.type === "CallExpression" &&
          raced.callee.type === "Identifier"
        )
          if (sleeps.has(raced.callee.name))
            record("raced timer", raced.arguments[0]);
          else if (raced.callee.name === "setTimeout")
            record("raced timer", raced.arguments[1]);
    // A request's own timer, as http's request.setTimeout sets.
    if (
      (method === "setTimeout" &&
        !(on.type === "Identifier" && on.name === "globalThis")) ||
      (method === "timeout" &&
        on.type === "Identifier" &&
        on.name === "AbortSignal")
    )
      record("request timeout", node.arguments[0]);
  }
  return [...found.values()].sort((a, b) => a.line - b.line);
}

test("every bound on a wait in the application tests is the shared hang bound", async () => {
  // A bound sized for an idle Mac fails its test when parallel checks load it.
  const files = (await readdir("tests/app"))
    .filter((file) => file.endsWith(".ts"))
    .sort();
  let count = 0;
  const others: string[] = [];
  const kept = new Set<string>();
  for (const file of files)
    for (const { line, kind, bound, shared } of await waits(
      await readFile(join("tests/app", file), "utf8"),
    )) {
      count++;
      if (deliberate.has(`${file}: ${bound}`)) kept.add(`${file}: ${bound}`);
      else if (!shared) others.push(`${file}:${line}: ${kind}: ${bound}`);
    }
  assert.ok(count > 0);
  assert.deepEqual(
    others,
    [],
    "Bound the wait with hang from tests/app/process-waits.ts.",
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
`;
  const call = (line: number, bound: string, shared = false) => ({
    line,
    kind: "process timeout",
    bound,
    shared,
  });
  assert.deepEqual(await waits(source), [
    call(6, "5_000"),
    call(7, "hang", true),
    call(8, "limit"),
    call(9, "30 * 1000"),
    call(10, "10_000"),
  ]);
  // A bound of the same name that the file sets itself is not the shared one.
  assert.deepEqual(
    await waits(`import { execFile } from "child_process";
const hang = 1000;
execFile("node", [], { timeout: hang });
`),
    [call(3, "hang")],
  );
});

test("the check finds the bounds of tests, raced timers, and requests", async () => {
  const source = `import { test, before as setup } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { request } from "@playwright/test";
import { hang as bound } from "./process-waits";
test("name", { timeout: 10_000 }, async (t) => {
  await t.test("part", { timeout: bound }, () => {});
});
setup(() => {}, { timeout: 5000 });
await Promise.race([work, sleep(1000).then(() => assert.fail())]);
await Promise.race([work, new Promise((_, reject) => setTimeout(reject, 2_000))]);
await Promise.race([work, sleep(bound, "late", { signal })]);
await sleep(2_500);
setTimeout(() => {}, 1000);
get(url).setTimeout(2000, () => {});
await fetch(url, { signal: AbortSignal.timeout(limit) });
const api = await request.newContext({ baseURL, timeout: 10_000 });
/ready/.test(output);
const waiting = { sleep, timeout: 5 * 60_000 };
`;
  const wait = (line: number, kind: string, bound: string, shared = false) => ({
    line,
    kind,
    bound,
    shared,
  });
  assert.deepEqual(await waits(source), [
    wait(5, "test timeout", "10_000"),
    wait(6, "test timeout", "bound", true),
    wait(8, "test timeout", "5000"),
    wait(9, "raced timer", "1000"),
    wait(10, "raced timer", "2_000"),
    wait(11, "raced timer", "bound", true),
    wait(14, "request timeout", "2000"),
    wait(15, "request timeout", "limit"),
    wait(16, "request timeout", "10_000"),
  ]);
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
