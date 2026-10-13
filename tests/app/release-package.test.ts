import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import {
  isCallExpression,
  isExportDeclaration,
  isImportDeclaration,
  isNoSubstitutionTemplateLiteral,
  isStringLiteral,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { releasePaths } from "../../scripts/release-paths";

// Production runs these from the unpacked release with `node --import tsx`:
// ops/activate.sh, ops/screenr-worker.service, and the one-off commands in
// docs/deployment.md and docs/usage-telemetry.md.
const maintenanceScripts = [
  "scripts/validate-config.ts",
  "scripts/migrate.ts",
  "scripts/worker.ts",
  "scripts/bootstrap.ts",
  "scripts/report-usage.ts",
];

// The specifiers of imports that load at runtime, in source order. Declarations
// marked `import type` or `export type` are erased. Other imports count even
// when only types use them, which can only ask for more files. Undefined marks
// an import() whose specifier is not a string literal.
function runtimeImports(source: SourceFile): (string | undefined)[] {
  const specifiers: (string | undefined)[] = [];
  const literal = (node: Node | undefined) =>
    node && (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  function visit(node: Node): void {
    if (isImportDeclaration(node)) {
      if (node.importClause?.phaseModifier !== SyntaxKind.TypeKeyword)
        specifiers.push(literal(node.moduleSpecifier));
    } else if (isExportDeclaration(node)) {
      if (node.moduleSpecifier && !node.isTypeOnly)
        specifiers.push(literal(node.moduleSpecifier));
    } else if (
      isCallExpression(node) &&
      node.expression.kind === SyntaxKind.ImportKeyword
    )
      specifiers.push(literal(node.arguments[0]));
    node.forEachChild(visit);
  }
  source.forEachChild(visit);
  return specifiers;
}

// Resolves a local specifier as tsx does: the exact file, a .js specifier's
// TypeScript source, an added extension, or a directory's index file.
async function resolveLocal(importer: string, specifier: string) {
  const base = resolve(dirname(importer), specifier);
  const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".json"];
  for (const candidate of [
    base,
    base.replace(/\.([cm]?)js(x?)$/, ".$1ts$2"),
    ...extensions.map((extension) => base + extension),
    ...extensions.map((extension) => join(base, `index${extension}`)),
  ])
    if ((await stat(candidate).catch(() => undefined))?.isFile())
      return candidate;
}

// Follows runtime imports from the entry points with TypeScript's parser.
// Returns each local module reached, relative to the root, with the module
// that first imported it, and every import this check cannot verify.
// TypeScript 7 publishes its parser only through the unstable API, so a
// compiler upgrade may need changes here.
async function loadedModules(root: string, entries: readonly string[]) {
  const config = join(root, "tsconfig.json");
  const { dependencies = {} } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const api = new API({ cwd: root });
  try {
    const project = api
      .updateSnapshot({ openProjects: [config] })
      .getProject(config);
    assert.ok(project, `TypeScript did not load ${config}`);
    const modules = new Map(entries.map((entry) => [entry, "the entry point"]));
    const problems: string[] = [];
    // A Map visits the modules added while it is iterated.
    for (const [path] of modules) {
      if (!/\.[cm]?tsx?$/.test(path)) continue;
      const source = project.program.getSourceFile(join(root, path));
      if (!source) {
        problems.push(`${path} is outside the TypeScript project`);
        continue;
      }
      for (const specifier of runtimeImports(source)) {
        if (specifier === undefined)
          problems.push(`${path} has an import() this test cannot follow`);
        else if (specifier.startsWith(".") || specifier.startsWith("/")) {
          const target = await resolveLocal(join(root, path), specifier);
          if (!target)
            problems.push(`${path} imports ${specifier}, which does not exist`);
          else if (!modules.has(relative(root, target)))
            modules.set(relative(root, target), path);
        } else {
          const name = specifier
            .split("/")
            .slice(0, specifier.startsWith("@") ? 2 : 1)
            .join("/");
          // The release installs only production dependencies.
          if (!isBuiltin(specifier) && !Object.hasOwn(dependencies, name))
            problems.push(
              `${path} imports ${specifier}, which is not a production dependency`,
            );
        }
      }
    }
    return { modules, problems };
  } finally {
    api.close();
  }
}

test("the release package includes every local module the maintenance scripts load", async () => {
  const { modules, problems } = await loadedModules(
    process.cwd(),
    maintenanceScripts,
  );
  assert.deepEqual(problems, []);
  const outside = [...modules]
    .filter(
      ([path]) =>
        !releasePaths.some(
          (root) => path === root || path.startsWith(`${root}/`),
        ),
    )
    .map(([path, importer]) => `${path}, imported by ${importer}`);
  assert.deepEqual(outside, [], "Add these paths to scripts/release-paths.ts");
});

test("the maintenance script list includes every script the ops files run", async () => {
  const run = new Set<string>();
  for (const item of await readdir("ops", { withFileTypes: true }))
    if (item.isFile())
      for (const [path] of (
        await readFile(join("ops", item.name), "utf8")
      ).matchAll(/\bscripts\/[\w.-]+\.[cm]?tsx?\b/g))
        run.add(path);
  assert.ok(run.has("scripts/worker.ts"));
  assert.deepEqual(
    [...run].filter((path) => !maintenanceScripts.includes(path)),
    [],
  );
});

test("the module walk follows every runtime import form and reports what it cannot verify", async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "screenr-release-modules-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      dependencies: { pg: "1", "@scope/runtime": "1" },
      devDependencies: { prettier: "1" },
    }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { module: "esnext", moduleResolution: "bundler" },
      include: ["**/*.ts"],
    }),
    "scripts/entry.ts": `import "./side";
import { a } from "../lib/a";
import type { Only } from "../lib/types-only";
import { type Mixed } from "../lib/mixed";
import pg from "pg";
import { tool } from "@scope/runtime/tool";
import { join } from "node:path";
import { format } from "prettier";
export * from "../lib/directory";
export { c } from "../lib/c.js";
export type { Exported } from "../lib/types-exported";
// import "./commented-out";
const text = 'import("./in-a-string")';
const b = await import(\`../lib/b\`);
const name = "../lib/hidden";
await import(name);
import "./missing";
`,
    "scripts/side.ts": "",
    "lib/a.ts": 'export * from "./reexported";\nexport const a = 1;\n',
    "lib/reexported.ts": "export const r = 1;\n",
    "lib/mixed.ts": "export type Mixed = 1;\n",
    "lib/directory/index.ts": "export const d = 1;\n",
    "lib/c.ts": "export const c = 1;\n",
    "lib/b.ts": "export const b = 1;\n",
    "lib/types-only.ts": "export type Only = 1;\n",
    "lib/types-exported.ts": "export type Exported = 1;\n",
    "lib/hidden.ts": "export const hidden = 1;\n",
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const { modules, problems } = await loadedModules(root, ["scripts/entry.ts"]);
  assert.deepEqual(Object.fromEntries(modules), {
    "scripts/entry.ts": "the entry point",
    "scripts/side.ts": "scripts/entry.ts",
    "lib/a.ts": "scripts/entry.ts",
    "lib/mixed.ts": "scripts/entry.ts",
    "lib/directory/index.ts": "scripts/entry.ts",
    "lib/c.ts": "scripts/entry.ts",
    "lib/b.ts": "scripts/entry.ts",
    "lib/reexported.ts": "lib/a.ts",
  });
  assert.deepEqual(problems, [
    "scripts/entry.ts imports prettier, which is not a production dependency",
    "scripts/entry.ts has an import() this test cannot follow",
    "scripts/entry.ts imports ./missing, which does not exist",
  ]);
});
