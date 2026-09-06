import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("Build the VPS release on Linux x64, outside the VPS.");
const output = ".cache/release";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(".next/standalone", output, {
  recursive: true,
  filter: (source) =>
    !source
      .split("/")
      .some((part) => part === "node_modules" || part.startsWith(".env")),
});
for (const path of [
  "public",
  "scripts",
  "src/server",
  "src/shared.ts",
  "db",
  "ops",
  "package.json",
  "package-lock.json",
]) {
  await cp(path, join(output, path), { recursive: true });
}
await cp(".next/static", join(output, ".next/static"), { recursive: true });
// Include complete runtime packages for the migration and worker entry points,
// which Next's web-only output tracing does not include.
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
  cwd: output,
  stdio: "inherit",
});
async function check(directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === "node_modules") continue;
    if (item.name.startsWith(".env") || [".git", ".cache"].includes(item.name))
      throw new Error(`Private path in release: ${item.name}`);
    if (item.isDirectory()) await check(join(directory, item.name));
  }
}
await check(output);
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
await writeFile(join(output, "REVISION"), revision + "\n");
const archive = `.cache/screenr-${revision}.tar.gz`;
execFileSync("tar", ["-czf", archive, "-C", output, "."], { stdio: "inherit" });
console.log(`Release: ${archive}`);
