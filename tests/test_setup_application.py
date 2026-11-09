"""Verify bin/setup-application, which bin/setup, bin/prep-worktree, and each new worktree run, with simulated tools."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from _process_waits import HANG_SECONDS

SOURCE = Path(__file__).resolve().parents[1]
NEXT = {"version": "16.4.2", "resolved": "https://registry.npmjs.org/next/-/next-16.4.2.tgz",
        "integrity": "sha512-next-16.4.2"}
REACT = {"version": "19.3.1", "resolved": "https://registry.npmjs.org/react/-/react-19.3.1.tgz",
         "integrity": "sha512-react-19.3.1"}
LOCKED = {"node_modules/next": NEXT, "node_modules/react": REACT}
INSTALL = ["npm", "ci"]
CHROMIUM = ["playwright", "install", "chromium"]


class SetupApplicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="screenr application setup ")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name)
        self.repo = base / "checkout"
        (self.repo / "bin").mkdir(parents=True)
        for name in ("bin/setup-application", "bin/_npm_packages.py"):
            shutil.copy2(SOURCE / name, self.repo / name)
        shutil.copy2(SOURCE / "package.json", self.repo / "package.json")
        (self.repo / "package-lock.json").write_text(json.dumps(self.lockfile(LOCKED, root=True)))
        self.events = base / "events.jsonl"
        self.tools = base / "tools"
        self.tools.mkdir()
        (self.tools / "python3").symlink_to(sys.executable)
        self.tool(self.tools / "node", "import os\nprint(os.environ.get('SETUP_NODE_VERSION', 'v24.20.0'))\n")
        # npm installs this fake playwright, which records how it was called.
        self.playwright = base / "playwright"
        self.tool(self.playwright, "import json, os, sys\n"
                                   "open(os.environ['SETUP_EVENTS'], 'a').write(json.dumps(['playwright', *sys.argv[1:]]) + '\\n')\n"
                                   "sys.exit(29 if 'FAIL_PLAYWRIGHT' in os.environ else 0)\n")
        # npm ci replaces node_modules with the locked packages and records them, as npm does.
        self.tool(self.tools / "npm", "import json, os, shutil, sys\n"
                                      "open(os.environ['SETUP_EVENTS'], 'a').write(json.dumps(['npm', *sys.argv[1:]]) + '\\n')\n"
                                      "if 'FAIL_NPM' in os.environ:\n"
                                      "    print('npm ci failed', file=sys.stderr)\n"
                                      "    sys.exit(23)\n"
                                      "shutil.rmtree('node_modules', ignore_errors=True)\n"
                                      "os.makedirs('node_modules/.bin')\n"
                                      "shutil.copy2(os.environ['SETUP_PLAYWRIGHT'], 'node_modules/.bin/playwright')\n"
                                      "lock = json.load(open('package-lock.json'))\n"
                                      "lock['packages'].pop('', None)\n"
                                      "json.dump(lock, open('node_modules/.package-lock.json', 'w'))\n")
        self.env = {key: value for key, value in os.environ.items()
                    if key not in {"FAIL_NPM", "FAIL_PLAYWRIGHT", "SETUP_NODE_VERSION"}}
        self.env.update(PATH=str(self.tools), SETUP_EVENTS=str(self.events), SETUP_PLAYWRIGHT=str(self.playwright),
                        PYTHONDONTWRITEBYTECODE="1")

    @staticmethod
    def lockfile(packages, root=False):
        """Return an npm lockfile; the hidden one that npm writes in node_modules leaves out the root package."""
        top = {"": {"name": "screenr", "version": "0.1.0"}} if root else {}
        return {"name": "screenr", "version": "0.1.0", "lockfileVersion": 3, "requires": True,
                "packages": top | packages}

    @staticmethod
    def tool(path, body):
        path.write_text("#!" + sys.executable + "\n" + body)
        path.chmod(0o755)

    def install(self, packages):
        """Leave node_modules as an earlier install did, with a file that only it holds."""
        (self.repo / "node_modules/.bin").mkdir(parents=True, exist_ok=True)
        (self.repo / "node_modules/.package-lock.json").write_text(json.dumps(self.lockfile(packages)))
        (self.repo / "node_modules/earlier-install").write_text("kept\n")
        shutil.copy2(self.playwright, self.repo / "node_modules/.bin/playwright")

    def setup_application(self, **extra):
        return subprocess.run([str(self.repo / "bin/setup-application")], cwd=self.repo, env=self.env | extra,
                              text=True, capture_output=True, timeout=HANG_SECONDS)

    def recorded(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []

    def assert_installed(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [INSTALL, CHROMIUM])
        self.assertEqual(json.loads((self.repo / "node_modules/.package-lock.json").read_text())["packages"], LOCKED)
        self.assertIn("Installing the locked packages with npm ci.", result.stdout)

    def test_a_new_checkout_gets_the_locked_packages_and_chromium(self):
        result = self.setup_application()
        self.assert_installed(result)
        self.assertIn("No packages are installed", result.stdout)

    def test_packages_that_differ_from_the_lockfile_are_reinstalled(self):
        # A pull moved package-lock.json to Next.js 16.4.2 while node_modules kept 16.4.0 (#334).
        self.install(LOCKED | {"node_modules/next": NEXT | {"version": "16.4.0"}})
        result = self.setup_application()
        self.assert_installed(result)
        self.assertIn("node_modules/next: 16.4.0 is installed but 16.4.2 is locked", result.stdout)
        self.assertFalse((self.repo / "node_modules/earlier-install").exists())

    def test_an_unreadable_install_record_is_reinstalled(self):
        self.install(LOCKED)
        (self.repo / "node_modules/.package-lock.json").write_text("{")
        result = self.setup_application()
        self.assert_installed(result)
        self.assertIn("node_modules/.package-lock.json cannot be read", result.stdout)

    def test_current_packages_are_kept_for_a_running_development_server(self):
        self.install(LOCKED)
        result = self.setup_application()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.recorded(), [CHROMIUM])
        self.assertTrue((self.repo / "node_modules/earlier-install").exists())
        self.assertIn("npm ci is not needed", result.stdout)

    def test_old_or_missing_node_stops_before_installing(self):
        for version in ("v22.18.0", "v23.11.1"):
            with self.subTest(version=version):
                result = self.setup_application(SETUP_NODE_VERSION=version)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Node.js >=24 is required", result.stderr)
                self.assertIn("latest Node LTS", result.stderr)
                self.assertIn("rerun bin/setup-application", result.stderr)
                self.assertIn(version, result.stderr)
                self.assertEqual(self.recorded(), [])
        (self.tools / "node").unlink()
        result = self.setup_application()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Node.js >=24 is required", result.stderr)
        self.assertEqual(self.recorded(), [])

    def test_an_unreadable_lockfile_stops_before_installing(self):
        self.install(LOCKED)
        (self.repo / "package-lock.json").write_text("{")
        result = self.setup_application()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("package-lock.json cannot be read", result.stderr)
        self.assertEqual(self.recorded(), [])
        self.assertTrue((self.repo / "node_modules/earlier-install").exists())

    def test_failed_installs_fail_setup(self):
        result = self.setup_application(FAIL_NPM="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("npm ci failed", result.stderr)
        self.assertEqual(self.recorded(), [INSTALL])
        self.events.unlink()
        self.install(LOCKED)
        result = self.setup_application(FAIL_PLAYWRIGHT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.recorded(), [CHROMIUM])

    def test_setup_application_is_executable_for_the_foundation(self):
        # bin/setup, bin/prep-worktree, and the post-checkout hook refuse a setup script they can't execute.
        self.assertTrue(os.access(SOURCE / "bin/setup-application", os.X_OK))


if __name__ == "__main__":
    unittest.main()
