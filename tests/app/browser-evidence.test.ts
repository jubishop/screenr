import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { retainBrowserEvidence } from "../../scripts/browser-evidence";

test("retained browser evidence is private and bounded across concurrent writers, age, size and file count", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "screenr-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const unrelated = join(directory, "unrelated.json");
  await writeFile(unrelated, "keep");
  const link = join(directory, `failure-${randomUUID()}.json`);
  await symlink(unrelated, link);
  const old = join(directory, `failure-${randomUUID()}.json`);
  await writeFile(old, "expired");
  await utimes(old, 1, 1);
  for (let i = 0; i < 30; i++)
    await writeFile(
      join(directory, `failure-${randomUUID()}.json`),
      "x".repeat(2 * 1024 * 1024),
    );
  const files = await Promise.all(
    ["first", "second", "third"].map((value) =>
      retainBrowserEvidence(JSON.stringify({ value }), directory),
    ),
  );
  await assert.rejects(stat(old), { code: "ENOENT" });
  for (let i = 0; i < files.length; i++) {
    assert.equal((await stat(files[i]!)).mode & 0o777, 0o600);
    assert.equal(
      JSON.parse(await readFile(files[i]!, "utf8")).value,
      ["first", "second", "third"][i],
    );
  }
  const sizes = await Promise.all(
    (await readdir(directory)).map(
      async (name) => (await stat(join(directory, name))).size,
    ),
  );
  assert.ok(
    sizes.reduce((sum, bytes) => sum + bytes, 0) <= 50 * 1024 * 1024 + 8,
  );
  await assert.rejects(
    retainBrowserEvidence("x".repeat(2 * 1024 * 1024 + 1), directory),
    /exceeds 2 MiB/,
  );
  for (let i = 0; i < 105; i++) await retainBrowserEvidence("{}", directory);
  assert.equal(
    (await readdir(directory)).filter((name) => name.startsWith("failure-"))
      .length,
    101,
    "100 owned regular files plus the untouched symlink",
  );
  assert.equal(await readFile(unrelated, "utf8"), "keep");
});
