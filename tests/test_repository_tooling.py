"""Exercise repository setup and hooks in disposable Git repositories."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


SOURCE = Path(__file__).resolve().parents[1]


class RepositoryToolingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="screenr tooling ")
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.repo = self.base / "main checkout"
        self.tools = self.base / "fake tools"
        self.tools.mkdir()
        self.events = self.base / "events.jsonl"
        self.approvals = self.base / "approvals.jsonl"
        self.env = {
            key: value for key, value in os.environ.items()
            if not key.startswith("GIT_")
        }
        self.env.update(
            PATH=str(self.tools) + os.pathsep + os.environ["PATH"],
            GIT_CONFIG_NOSYSTEM="1",
            GIT_CONFIG_GLOBAL=os.devnull,
            EVENTS=str(self.events),
            APPROVALS=str(self.approvals),
            QMD_CONFIG_DIR="/wrong-config",
            XDG_CACHE_HOME="/wrong-cache",
            INDEX_PATH="/wrong-index",
        )
        self.repo.mkdir()
        for directory in ("bin", ".config", "docs", "memory"):
            shutil.copytree(
                SOURCE / directory, self.repo / directory,
                ignore=shutil.ignore_patterns("index.yml", "__pycache__"),
            )
        for name in (".envrc", ".gitignore"):
            shutil.copy2(SOURCE / name, self.repo / name)
        self.write_tool("qmd", '''
import fcntl, json, os, sys, time
from pathlib import Path
with open(os.environ["EVENTS"] + ".writer", "a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    config = Path(os.environ["QMD_CONFIG_DIR"]) / "index.yml"
    record = {"command": sys.argv[1], "cwd": os.getcwd(), "config": str(config),
              "cache": os.environ["XDG_CACHE_HOME"], "index": os.environ["INDEX_PATH"],
              "config_text": config.read_text()}
    with open(os.environ["EVENTS"], "a") as events:
        events.write(json.dumps(record) + "\\n")
    time.sleep(0.05)  # Keep writers overlapping long enough to expose a missing lock.
    if sys.argv[1] == "update" and os.environ.get("FAIL_UPDATE"):
        sys.exit(23)
    Path(os.environ["INDEX_PATH"]).touch()
    print("fake qmd " + sys.argv[1])
''')
        self.write_tool("direnv", '''
import json, os, sys
with open(os.environ["APPROVALS"], "a") as events:
    events.write(json.dumps(sys.argv[1:]) + "\\n")
''')
        self.run_command("git", "init", "-b", "main")
        self.run_command("git", "config", "user.name", "Scaffold validation")
        self.run_command("git", "config", "user.email", "validation@example.invalid")

    def write_tool(self, name, body):
        tool = self.tools / name
        tool.write_text("#!/usr/bin/env python3\n" + body)
        tool.chmod(0o755)

    def run_command(self, *args, cwd=None, extra=None, check=True):
        result = subprocess.run(
            args, cwd=cwd or self.repo, env=self.env | (extra or {}),
            text=True, capture_output=True, timeout=20,
        )
        if check:
            self.assertEqual(result.returncode, 0, (args, result.stdout, result.stderr))
        return result

    def records(self):
        if not self.events.exists():
            return []
        return [json.loads(line) for line in self.events.read_text().splitlines()]

    def wait_for_refresh(self, count):
        deadline = time.monotonic() + 10
        while len(self.records()) < count:
            self.assertLess(time.monotonic(), deadline, self.records())
            time.sleep(0.02)
        # Join the real helper's lock after the final fake command starts.
        self.run_command("bin/qmd-index")

    def test_fresh_clone_uses_only_portable_collections(self):
        self.run_command("../bin/setup", cwd=self.repo / "docs")
        records = self.records()
        self.assertEqual([entry["command"] for entry in records], ["update", "embed"])
        self.assertNotIn("home-memory", records[0]["config_text"])
        config = json.loads(records[0]["config_text"])
        self.assertEqual(set(config["collections"]), {"memory", "docs"})
        self.assertEqual(config["collections"]["memory"]["ignore"], ["archive/**", "pr_reviews/**"])
        for entry in records:
            self.assertEqual(entry["cwd"], str(self.repo))
            self.assertEqual(entry["config"], str(self.repo / ".config/qmd/index.yml"))
            self.assertEqual(entry["cache"], str(self.repo / ".cache"))
            self.assertEqual(entry["index"], str(self.repo / ".cache/qmd/index.sqlite"))
        self.assertEqual(self.run_command("git", "config", "--get", "core.hooksPath").stdout.strip(), "bin/hooks")

    def test_home_memory_opt_in_and_removal(self):
        home_memory = self.base / 'personal notes "quoted"'
        home_memory.mkdir()
        self.run_command("git", "config", "--local", "screenr.homeMemoryPath", str(home_memory))
        self.run_command("bin/qmd-index")
        config = json.loads(self.records()[-1]["config_text"])
        self.assertEqual(config["collections"]["home-memory"]["path"], str(home_memory))
        self.run_command("git", "config", "--local", "--unset", "screenr.homeMemoryPath")
        self.run_command("bin/qmd-index")
        self.assertNotIn("home-memory", json.loads(self.records()[-1]["config_text"])["collections"])

    def test_missing_home_memory_is_reported_and_skipped(self):
        self.run_command("git", "config", "--local", "screenr.homeMemoryPath", str(self.base / "missing"))
        result = self.run_command("bin/qmd-index")
        self.assertIn("not a directory", result.stderr)
        self.assertNotIn("home-memory", json.loads(self.records()[-1]["config_text"])["collections"])

    def test_overlapping_refreshes_serialize_whole_pairs(self):
        processes = [subprocess.Popen(
            [str(self.repo / "bin/qmd-index")], cwd=self.repo, env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        ) for _ in range(3)]
        try:
            for process in processes:
                output = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 0, output)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
        self.assertEqual([entry["command"] for entry in self.records()], ["update", "embed"] * 3)

    def test_update_failure_skips_embedding_and_releases_lock(self):
        result = self.run_command("bin/qmd-index", extra={"FAIL_UPDATE": "1"}, check=False)
        self.assertEqual(result.returncode, 23)
        self.assertEqual([entry["command"] for entry in self.records()], ["update"])
        self.run_command("bin/qmd-index")
        self.assertEqual([entry["command"] for entry in self.records()], ["update", "update", "embed"])

    def test_missing_qmd_still_generates_scoped_configuration(self):
        self.run_command("bin/qmd-index", extra={"PATH": "/usr/bin:/bin"})
        self.assertTrue((self.repo / ".config/qmd/index.yml").is_file())
        self.assertEqual(self.records(), [])

    def test_missing_repository_config_never_uses_an_ancestor(self):
        (self.repo / ".config/qmd/collections.json").unlink()
        self.run_command("bin/qmd-index")
        self.assertEqual(self.records(), [])

    def test_hooks_and_worktree_isolation(self):
        home_memory = self.base / "personal notes"
        home_memory.mkdir()
        self.run_command("git", "config", "--local", "screenr.homeMemoryPath", str(home_memory))
        self.run_command("bin/setup")
        self.run_command("git", "add", ".")
        count = len(self.records())
        self.run_command("git", "commit", "-m", "Validation baseline")
        self.wait_for_refresh(count + 2)
        for hook, argument in (("post-merge", "0"), ("post-rewrite", "amend")):
            count = len(self.records())
            self.run_command("git", "hook", "run", hook, "--", argument)
            self.wait_for_refresh(count + 2)
        self.assertIn("fake qmd embed", (self.repo / ".cache/qmd/index.log").read_text())
        self.assertEqual(self.run_command("git", "status", "--porcelain").stdout, "")
        worktree = self.base / "feature checkout"
        count = len(self.records())
        self.run_command("git", "worktree", "add", "-b", "feature", str(worktree))
        # Wait in this checkout so the primary fake writer cannot overlap it.
        deadline = time.monotonic() + 10
        while len(self.records()) < count + 2:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.02)
        self.run_command("bin/qmd-index", cwd=worktree)
        models = worktree / ".cache/qmd/models"
        self.assertTrue(models.is_symlink())
        self.assertEqual(models.resolve(), self.repo / ".cache/qmd/models")
        self.assertFalse(os.path.samefile(worktree / ".cache/qmd/index.sqlite", self.repo / ".cache/qmd/index.sqlite"))
        self.assertEqual(self.records()[-1]["index"], str(worktree / ".cache/qmd/index.sqlite"))
        self.assertEqual(json.loads(self.records()[-1]["config_text"])["collections"]["home-memory"]["path"], str(home_memory))
        before = self.approvals.read_text()
        (worktree / ".envrc").write_text("# Divergent environment\n")
        self.run_command("bin/prep-worktree", str(worktree), cwd=worktree)
        self.assertEqual(self.approvals.read_text(), before)
        count = len(self.records())
        self.run_command("git", "hook", "run", "post-checkout", "--", "1" * 40, "2" * 40, "1", cwd=worktree)
        deadline = time.monotonic() + 10
        while len(self.records()) < count + 2:
            self.assertLess(time.monotonic(), deadline)
            time.sleep(0.02)
        self.run_command("bin/qmd-index", cwd=worktree)
        self.assertEqual(self.approvals.read_text(), before)
        (worktree / ".envrc").write_bytes((self.repo / ".envrc").read_bytes())
        for _ in range(2):
            self.run_command("bin/prep-worktree", str(worktree), cwd=worktree)
        self.assertTrue(models.is_symlink())
        self.run_command("git", "worktree", "remove", "--force", str(worktree))
        self.run_command("git", "branch", "-d", "feature")
        self.assertNotIn(str(worktree), self.run_command("git", "worktree", "list").stdout)


if __name__ == "__main__":
    unittest.main()
