"""Verify the application checks that bin/check --full runs, with simulated tools."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
SCRIPTS = ("format:check", "typecheck", "test", "test:browser")


class CheckApplicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="screenr application checks ")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.repo = base / "checkout"
        (self.repo / "bin").mkdir(parents=True)
        shutil.copy2(SOURCE / "bin/check-application", self.repo / "bin/check-application")
        shutil.copy2(SOURCE / "package.json", self.repo / "package.json")
        (self.repo / "ops").mkdir()
        (self.repo / "ops/deploy.sh").write_text("#!/bin/sh\nexit 0\n")
        (self.repo / "ops/Caddyfile").write_text("example.invalid\n")
        (self.repo / "tests").mkdir()
        self.events = base / "events.jsonl"
        for name in ("first", "second"):
            (self.repo / "tests" / f"test_{name}.py").write_text(
                "import json, os, unittest\n"
                "class Probe(unittest.TestCase):\n"
                "    def test_probe(self):\n"
                "        with open(os.environ['CHECK_EVENTS'], 'a') as stream:\n"
                f"            stream.write(json.dumps(['{name}']) + '\\n')\n"
                "        self.assertNotIn('FAIL_PYTHON', os.environ)\n")
        self.tools = base / "tools"
        self.tools.mkdir()
        (self.tools / "python3").symlink_to(sys.executable)
        self.tool("node", "import os\nprint(os.environ.get('CHECK_NODE_VERSION', 'v24.20.0'))\n")
        self.tool("shellcheck", "import json, os, sys\n"
                                "open(os.environ['CHECK_EVENTS'], 'a').write(json.dumps(['shellcheck', *[os.path.basename(a) for a in sys.argv[1:]]]) + '\\n')\n")
        self.tool("npm", "import json, os, sys\n"
                         "open(os.environ['CHECK_EVENTS'], 'a').write(json.dumps(['npm', *sys.argv[1:]]) + '\\n')\n"
                         "if sys.argv[-1] == os.environ.get('FAIL_APPLICATION'):\n"
                         "    print('application check failed: ' + sys.argv[-1], file=sys.stderr)\n"
                         "    sys.exit(17)\n")
        self.env = {key: value for key, value in os.environ.items() if key not in {"FAIL_PYTHON", "FAIL_APPLICATION"}}
        self.env.update(PATH=str(self.tools), CHECK_EVENTS=str(self.events), PYTHONDONTWRITEBYTECODE="1")

    def tool(self, name, body):
        path = self.tools / name
        path.write_text("#!" + sys.executable + "\n" + body)
        path.chmod(0o755)

    def check(self, **extra):
        return subprocess.run([str(self.repo / "bin/check-application")], cwd=self.repo, env=self.env | extra,
                              text=True, capture_output=True, timeout=60)

    def recorded(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []

    def test_runs_shell_lint_python_tests_then_npm_scripts_in_order(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [["shellcheck", "--shell=sh", "deploy.sh"], ["first"], ["second"],
                                           *[["npm", "run", script] for script in SCRIPTS]])
        self.assertIn("Application checks passed", result.stdout)

    def test_wrong_or_missing_node_stops_before_any_check(self):
        for version in ("v22.18.0", "v25.8.0", "v26.8.1"):
            with self.subTest(version=version):
                result = self.check(CHECK_NODE_VERSION=version)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Node.js 24.x is required", result.stderr)
                self.assertIn(version, result.stderr)
                self.assertEqual(self.recorded(), [])
        (self.tools / "node").unlink()
        result = self.check()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Node.js 24.x is required", result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_failures_propagate_and_stop_later_commands(self):
        result = self.check(FAIL_PYTHON="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("npm", [event[0] for event in self.recorded()])
        for index, script in enumerate(SCRIPTS):
            with self.subTest(script=script):
                self.events.unlink(missing_ok=True)
                result = self.check(FAIL_APPLICATION=script)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("application check failed: " + script, result.stderr)
                self.assertEqual([event for event in self.recorded() if event[0] == "npm"],
                                 [["npm", "run", name] for name in SCRIPTS[:index + 1]])


if __name__ == "__main__":
    unittest.main()
