import { cp, mkdir, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { join, dirname, isAbsolute, relative, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error("Build the VPS release on Linux x64, outside the VPS.");
const output = ".cache/release";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
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
// Maintenance scripts need complete runtime packages. Install them before
// overlaying Next's traced output, which also contains generated external-module
// aliases under nested node_modules directories.
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
  cwd: output,
  stdio: "inherit",
});
await cp(".next/standalone", output, {
  recursive: true,
  verbatimSymlinks: true,
  filter: (source) =>
    !source
      .split("/")
      .some(
        (part) => [".cache", ".git"].includes(part) || part.startsWith(".env"),
      ),
});
await cp(".next/static", join(output, ".next/static"), { recursive: true });
async function check(directory: string): Promise<void> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (
      !path.split("/").includes("node_modules") &&
      (item.name.startsWith(".env") || [".git", ".cache"].includes(item.name))
    )
      throw new Error(`Private path in release: ${path}`);
    if (item.isSymbolicLink()) {
      const target = await readlink(path);
      if (
        isAbsolute(target) ||
        relative(resolve(output), resolve(dirname(path), target)).startsWith(
          "..",
        )
      )
        throw new Error(`Escaping release link: ${path}`);
    } else if (item.isDirectory()) await check(path);
  }
}
await check(output);

const testDatabase =
  process.env.TEST_DATABASE_URL ??
  "postgresql://screenr:screenr-local-only@127.0.0.1:5439/screenr_test";
if (!new URL(testDatabase).pathname.endsWith("_test"))
  throw new Error("Release verification requires a dedicated test database.");
const server = spawn(process.execPath, ["server.js"], {
  cwd: output,
  env: {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    NODE_OPTIONS: "--max-old-space-size=256",
    HOSTNAME: "127.0.0.1",
    PORT: "3057",
    TZ: "UTC",
    DATABASE_URL: testDatabase,
    BETTER_AUTH_URL: "http://localhost:3057",
    BETTER_AUTH_SECRET: "release-smoke-test-only-never-used-in-production",
    EMAIL_TRANSPORT: "file",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "",
  finished = false;
server.stdout.on("data", (data) => {
  logs = (logs + data).slice(-8000);
});
server.stderr.on("data", (data) => {
  logs = (logs + data).slice(-8000);
});
const closed = new Promise<void>((resolve) =>
  server.on("exit", () => {
    finished = true;
    resolve();
  }),
);
try {
  let healthy = false;
  for (let attempt = 0; attempt < 60 && !finished; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:3057/api/health", {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok && (await response.json()).ok) {
        healthy = true;
        break;
      }
    } catch {
      /* Wait for startup within the bounded window. */
    }
    await delay(250);
  }
  if (!healthy || finished)
    throw new Error(`Packaged server health check failed.\n${logs}`);
  const login = await fetch("http://127.0.0.1:3057/login");
  if (!login.ok || !(await login.text()).includes("Send sign-in code"))
    throw new Error(`Packaged login page failed.\n${logs}`);
  console.log("Packaged production server and database access passed.");
} finally {
  server.kill("SIGTERM");
  await Promise.race([closed, delay(5000, undefined, { ref: false })]);
  if (!finished) {
    server.kill("SIGKILL");
    await closed;
  }
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
await writeFile(join(output, "REVISION"), revision + "\n");
const archive = `.cache/screenr-${revision}.tar.gz`;
execFileSync("tar", ["-czf", archive, "-C", output, "."], { stdio: "inherit" });
console.log(`Release: ${archive}`);
