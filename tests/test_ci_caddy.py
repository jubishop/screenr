"""Run CI's Install Caddy step against a fake Docker whose registry fails, as Docker Hub did in #379."""
import os
from pathlib import Path
import re
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[1]
IMAGE = re.search(r"^FROM (.+)$", (ROOT / ".github/caddy/Dockerfile").read_text(), re.M)[1]
ATTEMPTS = 4
DELAYS = ["5", "10", "15"]
# CI run 40269940985 failed with this when Docker Hub answered a blob request with 502.
REGISTRY_ERROR = ("unknown: failed to copy: httpReadSeeker: failed open: unexpected status from GET request "
                  "to https://registry-1.docker.io/v2/library/caddy/blobs/sha256:c556e15e: 502 Bad Gateway")

# Stands in for docker. The registry fails the first $FIXTURE/failures pulls,
# counting the pull that docker create makes for an image it lacks.
FAKE_DOCKER = f"""#!/usr/bin/env python3
import os, sys
from pathlib import Path
fixture = Path(os.environ["FIXTURE"])
with open(fixture / "log", "a") as log:
    print("docker", *sys.argv[1:], file=log)
command = sys.argv[1]
if command in ("pull", "create") and not (fixture / "pulled").exists():
    failures = fixture / "failures"
    remaining = int(failures.read_text())
    if remaining:
        failures.write_text(str(remaining - 1))
        sys.exit({REGISTRY_ERROR!r})
    (fixture / "pulled").touch()
if command == "pull":
    print(sys.argv[-1])
elif command == "create":
    print("fixture-container")
elif command == "cp":
    Path(sys.argv[-1]).write_text("caddy binary")
elif command == "rm":
    print(sys.argv[-1])
"""

# Stand in for sleep, sudo, and caddy, logging each call; caddy also prints a version.
LOGGED = '#!/bin/sh\necho "{name} $*" >> "$FIXTURE/log"\n'


class InstallCaddyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        commands = self.base / "commands"
        commands.mkdir()
        for name in ("docker", "sleep", "sudo", "caddy"):
            script = FAKE_DOCKER if name == "docker" else LOGGED.format(name=name)
            if name == "caddy":
                script += "echo v2.11.7\n"
            (commands / name).write_text(script)
            (commands / name).chmod(0o755)
        self.path = f"{commands}{os.pathsep}{os.environ['PATH']}"
        jobs = (ROOT / ".github/workflows/check.yml").read_text().split("\njobs:\n")[1]
        app = re.search(r"^  app:\n((?:(?:    .*)?\n)*)", jobs, re.M)[1]
        step = next(step for step in re.split(r"^      - ", app, flags=re.M)
                    if step.startswith("name: Install Caddy\n"))
        self.script = textwrap.dedent(step.split("        run: |\n", 1)[1])

    def install(self, failures):
        """Run the step on a fresh runner whose registry fails the first failures pulls."""
        fixture = Path(tempfile.mkdtemp(dir=self.base))
        runner = fixture / "runner"
        runner.mkdir()
        (fixture / "failures").write_text(str(failures))
        environment = {**os.environ, "PATH": self.path, "FIXTURE": str(fixture), "RUNNER_TEMP": str(runner)}
        # GitHub runs a step that sets no shell with bash -e, as the app job's log shows.
        result = subprocess.run(["bash", "-e", "-c", self.script],
                                cwd=ROOT, env=environment, capture_output=True, text=True, timeout=30)
        log = fixture / "log"
        return result, log.read_text().splitlines() if log.exists() else [], runner

    def test_retries_transient_registry_failures_and_installs_the_pinned_caddy(self):
        for failures in range(ATTEMPTS):
            with self.subTest(failures=failures):
                result, log, runner = self.install(failures)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual([line for line in log if line.startswith("docker pull ")],
                                 [f"docker pull --quiet {IMAGE}"] * (failures + 1))
                self.assertEqual([line.split()[1] for line in log if line.startswith("sleep ")],
                                 DELAYS[:failures])
                self.assertEqual(result.stderr.count(REGISTRY_ERROR), failures)
                self.assertEqual((runner / "caddy").read_text(), "caddy binary")
                self.assertIn(f"docker create --quiet {IMAGE}", log)
                self.assertIn("docker rm fixture-container", log)
                self.assertEqual(log[-2:], [f"sudo install -m 0755 {runner}/caddy /usr/local/bin/caddy",
                                            "caddy version"])

    def test_fails_when_the_registry_keeps_failing(self):
        result, log, runner = self.install(ATTEMPTS)
        self.assertNotEqual(result.returncode, 0)
        pull = f"docker pull --quiet {IMAGE}"
        self.assertEqual(log, [pull, "sleep 5", pull, "sleep 10", pull, "sleep 15", pull])
        self.assertIn(REGISTRY_ERROR, result.stderr)
        self.assertIn(f"Could not pull {IMAGE} after {ATTEMPTS} attempts.", result.stderr)
        self.assertFalse((runner / "caddy").exists())


if __name__ == "__main__":
    unittest.main()
