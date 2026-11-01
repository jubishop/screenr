"""Exercise bin/node-lts against fixture release indexes, and check that every CI job installs Node through it."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "bin/node-lts"
ACTION = ".github/actions/node-lts"

# Shaped like https://nodejs.org/dist/index.json on 2026-11-01, plus a newer
# Current major and a later security release of the older LTS line: neither may
# outrank the newest LTS release.
RELEASES = [
    {"version": "v27.0.0-alpha.0.0.0", "lts": False},
    {"version": "v27.0.0", "lts": False},
    {"version": "v24.22.3", "lts": "Krypton"},
    {"version": "v26.13.0", "lts": "Lithium"},
    {"version": "v26.12.1", "lts": False},
    {"version": "v25.9.0", "lts": False},
    {"version": "v24.22.2", "lts": "Krypton"},
    {"version": "v22.21.0", "lts": "Jod"},
]

# Stands in for node -p: prints the version and LTS codename the test sets.
FAKE_NODE = """#!/usr/bin/env python3
import json, os
print(json.dumps([os.environ["FAKE_NODE_VERSION"], os.environ.get("FAKE_NODE_LTS") or None]))
"""


class NodeLtsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.index = self.base / "index.json"
        self.index.write_text(json.dumps(RELEASES))

    def run_script(self, *args, index=None, env=None):
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--index", index or self.index.as_uri(), *args],
            capture_output=True, text=True, timeout=30, env={**os.environ, **(env or {})},
        )

    def fake_node(self, version, lts):
        commands = self.base / "commands"
        commands.mkdir(exist_ok=True)
        (commands / "node").write_text(FAKE_NODE)
        (commands / "node").chmod(0o755)
        return {"PATH": str(commands) + os.pathsep + os.environ["PATH"],
                "FAKE_NODE_VERSION": version, "FAKE_NODE_LTS": lts or ""}

    def test_prints_the_newest_lts_release_for_setup_node(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "version=26.13.0\n")
        self.assertIn("v26.13.0 (Lithium)", result.stderr)

    def test_fails_when_the_index_marks_no_release_as_lts(self):
        self.index.write_text(json.dumps([{"version": "v27.0.0", "lts": False}]))
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("marks no release as LTS", result.stderr)

    def test_fails_on_an_unreadable_index(self):
        for contents in ("<html>Service unavailable</html>", '{"version": "v26.13.0"}'):
            with self.subTest(contents=contents):
                self.index.write_text(contents)
                result = self.run_script()
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn("Node release index", result.stderr)

    def test_retries_a_transient_server_failure(self):
        requests = []
        body = json.dumps(RELEASES).encode()

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                if len(requests) == 1:
                    self.send_error(503)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        result = self.run_script(index=f"http://127.0.0.1:{server.server_port}/dist/index.json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "version=26.13.0\n")
        self.assertEqual(requests, ["/dist/index.json", "/dist/index.json"])

    def test_check_passes_for_the_newest_lts_major(self):
        result = self.run_script("--check", env=self.fake_node("v26.13.0", "Lithium"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("v26.13.0", result.stdout)

    def test_check_fails_when_node_runs_an_older_lts_major(self):
        # setup-node's lts/* installed this on 2026-11-01, before its manifest marked 26.x LTS (#369).
        result = self.run_script("--check", env=self.fake_node("v24.22.2", "Krypton"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("v24.22.2", result.stderr)
        self.assertIn("v26.13.0 (Lithium)", result.stderr)

    def test_check_fails_for_a_current_release_of_the_lts_major(self):
        result = self.run_script("--check", env=self.fake_node("v26.12.1", None))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("v26.12.1", result.stderr)

    def test_check_fails_for_a_newer_current_major(self):
        result = self.run_script("--check", env=self.fake_node("v27.0.0", None))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("v27.0.0", result.stderr)

    @unittest.skipUnless(shutil.which("node"), "needs Node on PATH")
    def test_check_reads_the_real_node_runtime(self):
        version, lts = json.loads(subprocess.check_output(
            ["node", "-p", "JSON.stringify([process.version, process.release.lts || null])"], text=True))
        if not lts:
            self.skipTest(f"Node {version} on PATH is not an LTS release")
        self.index.write_text(json.dumps([{"version": version, "lts": lts}]))
        result = self.run_script("--check")
        self.assertEqual(result.returncode, 0, result.stderr)
        major = int(version.removeprefix("v").split(".")[0])
        self.index.write_text(json.dumps([{"version": f"v{major + 1}.0.0", "lts": "Newer"},
                                          {"version": version, "lts": lts}]))
        result = self.run_script("--check")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(version, result.stderr)


def jobs(workflow):
    """Map each job in a workflow file to its text, without comment lines."""
    text = re.sub(r"^ *#.*\n", "", workflow.read_text(), flags=re.M)
    return dict(re.findall(r"^  ([a-z][a-z-]*):\n((?:(?:    .*)?\n)*)", text.split("\njobs:\n")[1], re.M))


class WorkflowNodeTests(unittest.TestCase):
    """Every CI job installs Node through the one action that resolves the newest LTS."""

    def test_only_the_shared_action_runs_setup_node_with_the_resolved_version(self):
        files = [*(ROOT / ".github/workflows").glob("*.y*ml"), *(ROOT / ".github/actions").glob("*/action.y*ml")]
        users = [path.relative_to(ROOT).as_posix() for path in files if "actions/setup-node@" in path.read_text()]
        self.assertEqual(users, [f"{ACTION}/action.yml"])
        action = (ROOT / ACTION / "action.yml").read_text()
        self.assertEqual(len(re.findall(r"actions/setup-node@", action)), 1)
        resolve = action.index('      id: lts\n      shell: bash\n      run: bin/node-lts >> "$GITHUB_OUTPUT"\n')
        setup = action.index("    - uses: actions/setup-node@")
        check = action.index("      shell: bash\n      run: bin/node-lts --check\n")
        self.assertLess(resolve, setup)
        self.assertLess(setup, check)
        self.assertIn("        node-version: ${{ steps.lts.outputs.version }}\n", action[setup:check])

    def test_every_job_that_runs_node_installs_it_through_the_shared_action_first(self):
        using = []
        for workflow in sorted((ROOT / ".github/workflows").glob("*.y*ml")):
            for name, job in jobs(workflow).items():
                node = re.search(r"(?<![\w./-])(?:npm|npx|node)(?![\w-])|bin/check-application", job)
                if not node:
                    continue
                with self.subTest(workflow=workflow.name, job=name):
                    setup = job.find(f"uses: ./{ACTION}\n")
                    self.assertNotEqual(setup, -1)
                    self.assertLess(setup, node.start())
                    using.append(f"{workflow.name}:{name}")
        self.assertEqual(using, [f"check.yml:{name}" for name in ("static", "app", "browser", "release")])


if __name__ == "__main__":
    unittest.main()
