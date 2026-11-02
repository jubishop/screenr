"""Exercise bin/ci-scope, which decides whether a CI run needs the check jobs,
through its command and real merge commits.

GitHub checks out a pull request's test merge commit, whose first parent is
the base it merged into. These fixtures build the same shape.
"""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
# The fixture repository's commands must not follow Git's repository
# variables to the checkout that runs these tests.
REPOSITORY_VARIABLES = set(subprocess.run(["git", "rev-parse", "--local-env-vars"], check=True,
                                          capture_output=True, text=True).stdout.split())


class CiScopeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.environment = {key: value for key, value in os.environ.items()
                            if key not in REPOSITORY_VARIABLES}
        # A fixture that is not a repository must not find one above it.
        temporary_root = Path(tempfile.gettempdir())
        self.environment["GIT_CEILING_DIRECTORIES"] = os.pathsep.join(
            {str(temporary_root), str(temporary_root.resolve())})

    def git(self, *args):
        return subprocess.run(["git", "-c", "core.hooksPath=/dev/null", *args], cwd=self.directory,
                              env=self.environment, check=True, capture_output=True, text=True).stdout

    def commit(self, message, files=(), removed=()):
        for name in files:
            path = self.directory / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"{message}\n")
        for name in removed:
            self.git("rm", "-q", name)
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", message)

    def pull_request(self, *files, removed=(), base_moves=()):
        """Build GitHub's test merge of a pull request that changes files into
        main, after main gains base_moves, and leave it checked out."""
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.com")
        self.commit("Base", ("src/app.ts", "bin/tool", "vendor/README.md", "docs/guide.md"))
        self.git("checkout", "-qb", "topic")
        self.commit("Change", files, removed)
        self.git("checkout", "-q", "main")
        if base_moves:
            self.commit("Move the base", base_moves)
        self.git("merge", "-q", "--no-ff", "-m", "Merge topic into main", "topic")

    def scope(self, event="pull_request"):
        result = subprocess.run([sys.executable, str(ROOT / "bin/ci-scope"), event], cwd=self.directory,
                                env=self.environment, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def assertRuns(self, expected, event="pull_request"):
        result = self.scope(event)
        self.assertEqual(result.stdout, f"run={'true' if expected else 'false'}\n", result.stderr)
        self.assertTrue(result.stderr.strip())

    def test_markdown_in_other_folders_skips_the_checks(self):
        # No tracked Markdown lives there; tests/test_app_sandbox.py checks that.
        self.pull_request("vendor/README.md", "vendor/lib/notes.md")
        self.assertRuns(False)

    def test_any_other_file_runs_the_checks(self):
        for files in (("src/app.ts",), ("vendor/README.md", "bin/tool"), ("ios/Screenr/App.swift",),
                      ("README.txt",), (".github/workflows/check.yml",)):
            with self.subTest(files=files), tempfile.TemporaryDirectory() as directory:
                self.directory = Path(directory)
                self.pull_request(*files)
                self.assertRuns(True)

    def test_markdown_that_tests_read_runs_the_checks(self):
        # tests/test_app_sandbox.py scans the Markdown in docs/, memory/, and
        # the root (#371), at any depth.
        for path in ("docs/guide.md", "docs/foundation/policy.md", "memory/note.md",
                     "memory/archive/old.md", "README.md", "AGENTS.md"):
            with self.subTest(path=path), tempfile.TemporaryDirectory() as directory:
                self.directory = Path(directory)
                self.pull_request("vendor/README.md", path)
                self.assertRuns(True)

    def test_markdown_that_the_document_checks_read_runs_the_checks(self):
        # bin/check --documents-only checks the links in every tracked Markdown
        # file, and outside the folders above it lives in ios/ and bin/ (#439).
        for path in ("ios/README.md", "ios/AGENTS.md", "ios/Screenr/Notes.md",
                     "bin/memory-audit-prompt.md", "bin/notes/guide.md"):
            with self.subTest(path=path), tempfile.TemporaryDirectory() as directory:
                self.directory = Path(directory)
                self.pull_request("vendor/README.md", path)
                self.assertRuns(True)

    def test_a_deleted_or_renamed_file_counts_by_its_old_path(self):
        self.pull_request(removed=("bin/tool",))
        self.assertRuns(True)
        with tempfile.TemporaryDirectory() as directory:
            self.directory = Path(directory)
            self.pull_request()
            self.git("checkout", "-q", "topic")
            self.git("mv", "bin/tool", "vendor/tool.md")
            self.git("commit", "-qm", "Rename the tool")
            self.git("checkout", "-q", "main")
            self.git("merge", "-q", "--no-ff", "-m", "Merge topic into main again", "topic")
            self.assertRuns(True)

    def test_changes_already_on_the_base_do_not_count(self):
        self.pull_request("vendor/README.md", base_moves=("src/app.ts",))
        self.assertRuns(False)

    def test_other_events_run_the_checks_without_reading_changes(self):
        # The directory is not even a repository.
        for event in ("push", "workflow_dispatch"):
            with self.subTest(event=event):
                self.assertRuns(True, event)

    def test_any_doubt_runs_the_checks(self):
        # Not a repository, then a commit that is not a test merge.
        self.assertRuns(True)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.com")
        self.commit("Docs", ("vendor/README.md",))
        self.assertRuns(True)

    def test_an_empty_change_runs_the_checks(self):
        self.pull_request()
        self.assertRuns(True)

    def test_a_missing_event_is_an_error(self):
        result = subprocess.run([sys.executable, str(ROOT / "bin/ci-scope")], cwd=self.directory,
                                env=self.environment, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
