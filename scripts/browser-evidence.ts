import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, lstat, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const maxFileBytes = 2 * 1024 * 1024;
const maxTotalBytes = 50 * 1024 * 1024;
const maxAge = 7 * 24 * 60 * 60 * 1000;

// Isolation children receive their source checkout's directory so evidence
// survives disposal of both copied checkouts. Only owned JSON files are pruned.
export async function retainBrowserEvidence(
  contents?: string,
  directory = process.env.SCREENR_BROWSER_EVIDENCE_DIR ??
    resolve(".cache/browser-failures"),
) {
  const bytes = contents === undefined ? 0 : Buffer.byteLength(contents);
  if (bytes > maxFileBytes) throw new Error("Browser evidence exceeds 2 MiB");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, ".lock");
  let lock;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A stale lock needs explicit inspection; never steal a live writer's lock.
      await delay(50);
    }
  }
  if (!lock) throw new Error(`Browser evidence lock unavailable: ${lockPath}`);
  try {
    const files = [];
    for (const name of await readdir(directory)) {
      if (!/^failure-[a-f0-9-]{36}\.json$/.test(name)) continue;
      const path = join(directory, name);
      const stat = await lstat(path);
      if (!stat.isFile()) continue;
      if (stat.mtimeMs < Date.now() - maxAge) await rm(path);
      else files.push({ path, time: stat.mtimeMs, bytes: stat.size });
    }
    files.sort((a, b) => a.time - b.time);
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    while (
      files.length &&
      (total + bytes > maxTotalBytes || files.length >= 100)
    ) {
      const file = files.shift()!;
      await rm(file.path);
      total -= file.bytes;
    }
    if (contents === undefined) return;
    const path = join(directory, `failure-${randomUUID()}.json`);
    await writeFile(path, contents, { mode: 0o600, flag: "wx" });
    return path;
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}
