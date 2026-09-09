import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("npm rejects other Node majors before running application commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "screenr-runtime-"));
  try {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: "screenr-runtime-fixture",
        private: true,
        engines: manifest.engines,
        devEngines: manifest.devEngines,
        scripts: { dev: "node -e \"console.log('application started')\"" },
      }),
    );
    const preload = join(directory, "runtime.cjs");
    // The runtime is the external boundary; npm reads the real project policy.
    await writeFile(
      preload,
      `Object.defineProperty(process, "version", { value: "v" + process.env.TEST_NODE_VERSION });
Object.defineProperty(process.versions, "node", { value: process.env.TEST_NODE_VERSION });
`,
    );
    for (const version of ["24.20.0", "22.18.0", "25.8.0", "26.8.1"]) {
      const result = await execute("npm", ["run", "dev"], {
        cwd: directory,
        timeout: 10000,
        env: {
          ...process.env,
          NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
          TEST_NODE_VERSION: version,
          npm_config_force: "false",
        },
      }).then(
        (output) => ({ ...output, code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error,
      );
      if (version.startsWith("24.")) {
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /application started/);
      } else {
        assert.notEqual(result.code, 0, version);
        assert.match(result.stderr, /EBADDEVENGINES/);
        assert.doesNotMatch(result.stdout, /application started/);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
