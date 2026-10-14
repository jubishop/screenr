"""Verify the pre-push hook with real pushes to a local remote and a simulated bin/check-ios."""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
# The simulated check records where it ran and fails when FAIL_CHECK is set.
CHECK_IOS = """import json, os, sys
with open(os.environ['CHECK_EVENTS'], 'a') as stream:
    stream.write(json.dumps(['check-ios', os.getcwd(), *sys.argv[1:]]) + '\\n')
sys.exit(int(os.environ.get('FAIL_CHECK', '0')))
"""
XCODEBUILD = """import os, sys
if sys.argv[1:] != ['-version']:
    sys.exit('unexpected xcodebuild ' + ' '.join(sys.argv[1:]))
print(os.environ.get('FAKE_XCODE_VERSION', 'Xcode 27.0\\nBuild version 27A266a'))
"""


class PrePushTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="screenr pre-push ")
        self.addCleanup(temporary.cleanup)
        base = Path(temporary.name).resolve()
        self.events = base / "events.jsonl"
        self.tools = base / "tools"
        self.tools.mkdir()
        (self.tools / "python3").symlink_to(sys.executable)
        (self.tools / "git").symlink_to(shutil.which("git"))
        self.tool(self.tools / "xcodebuild", XCODEBUILD)
        self.env = {key: value for key, value in os.environ.items()
                    if key not in {"FAIL_CHECK", "FAKE_XCODE_VERSION"} and not key.startswith("GIT_")}
        self.env.update(PATH=str(self.tools), CHECK_EVENTS=str(self.events), PYTHONDONTWRITEBYTECODE="1",
                        GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        self.remote = base / "remote.git"
        self.repo = base / "checkout"
        (self.repo / "bin/hooks").mkdir(parents=True)
        shutil.copy2(SOURCE / "bin/hooks/pre-push", self.repo / "bin/hooks/pre-push")
        shutil.copy2(SOURCE / "bin/_ios_check_records.py", self.repo / "bin/_ios_check_records.py")
        self.tool(self.repo / "bin/check-ios", CHECK_IOS)
        (self.repo / "bin/format-swift").write_text("#!/bin/sh\n")
        (self.repo / "ios").mkdir()
        (self.repo / "src").mkdir()
        self.write("ios/App.swift", "struct App {}\n")
        self.write("src/page.ts", "export const page = 1;\n")
        self.git("init", "--quiet", "--bare", "--initial-branch=main", str(self.remote), cwd=base)
        self.git("init", "--quiet", "--initial-branch=main")
        self.git("config", "user.name", "Check")
        self.git("config", "user.email", "check@example.invalid")
        self.git("remote", "add", "origin", str(self.remote))
        self.commit("Main")
        self.git("-c", "core.hooksPath=/dev/null", "push", "--quiet", "origin", "main")
        # Like bin/setup, which points core.hooksPath at the bundled hooks.
        self.git("config", "core.hooksPath", "bin/hooks")

    def tool(self, path, body):
        path.write_text("#!" + sys.executable + "\n" + body)
        path.chmod(0o755)

    def write(self, name, text):
        (self.repo / name).write_text(text)

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.repo, env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, message, *changes):
        for name, text in changes:
            self.write(name, text)
        self.git("add", "--all")
        self.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--message", message)
        return self.git("rev-parse", "HEAD")

    def push(self, *args, **extra):
        return subprocess.run(["git", "push", "origin", *args], cwd=self.repo, env=self.env | extra,
                              capture_output=True, text=True, timeout=60)

    def remote_has(self, ref):
        return bool(self.git("ls-remote", str(self.remote), ref))

    def checks(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []

    def records(self):
        return sorted((self.repo / ".git/screenr-ios-checks").glob("*.json"))

    def test_a_push_that_changes_ios_runs_the_check_at_the_checkout_root_first(self):
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        result = self.push("HEAD:refs/heads/feature")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.checks(), [["check-ios", str(self.repo)]])
        self.assertIn("feature changes the iOS files; running bin/check-ios", result.stderr)
        self.assertTrue(self.remote_has("refs/heads/feature"))
        self.assertEqual(len(self.records()), 1)

    def test_bin_format_swift_counts_as_an_ios_file_but_bin_check_ios_does_not(self):
        # The simulated check keeps working when its file changes.
        self.commit("Check differently", ("bin/check-ios", "#!" + sys.executable + "\n# v2\n" + CHECK_IOS))
        result = self.push("HEAD:refs/heads/check", FAIL_CHECK="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.checks(), [])
        self.commit("Format differently", ("bin/format-swift", "#!/bin/sh\n# stricter\n"))
        result = self.push("HEAD:refs/heads/format")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.checks()), 1)

    def test_a_failing_check_refuses_the_push(self):
        self.commit("Break the app", ("ios/App.swift", "struct App { broken }\n"))
        result = self.push("HEAD:refs/heads/feature", FAIL_CHECK="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bin/check-ios failed with status 1, so the push stopped", result.stderr)
        self.assertIn("Never bypass this check with git push --no-verify.", result.stderr)
        self.assertFalse(self.remote_has("refs/heads/feature"))
        self.assertEqual(self.records(), [])
        result = self.push("HEAD:refs/heads/main", FAIL_CHECK="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotEqual(self.git("ls-remote", str(self.remote), "refs/heads/main").split()[0],
                            self.git("rev-parse", "HEAD"))

    def test_pushes_that_leave_ios_alone_skip_the_check(self):
        self.commit("Edit the web", ("src/page.ts", "export const page = 2;\n"))
        # A new branch compares with where it left origin/main; main with its remote commit.
        for ref in ("HEAD:refs/heads/web", "HEAD:refs/heads/main"):
            with self.subTest(ref=ref):
                result = self.push(ref)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr.count("pre-push:"), 0)
        self.assertEqual(self.checks(), [])

    def test_markdown_under_ios_is_not_an_ios_file(self):
        (self.repo / "ios/Docs").mkdir()
        self.commit("Document the app", ("ios/README.md", "# The iPhone app\n"),
                    ("ios/Docs/Guide.md", "Guide.\n"))
        result = self.push("HEAD:refs/heads/docs", FAIL_CHECK="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.checks(), [])
        # Uncommitted Markdown does not stop a check of the pushed commit.
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.write("ios/README.md", "# Draft\n")
        result = self.push("HEAD:refs/heads/feature")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.checks()), 1)
        self.assertEqual(len(self.records()), 1)

    def test_an_existing_branch_compares_with_its_remote_commit(self):
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.assertEqual(self.push("HEAD:refs/heads/feature").returncode, 0)
        shutil.rmtree(self.repo / ".git/screenr-ios-checks")
        self.commit("Edit the web", ("src/page.ts", "export const page = 2;\n"))
        result = self.push("HEAD:refs/heads/feature")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.checks()), 1)

    def test_tags_and_branch_deletions_skip_the_check(self):
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.git("tag", "ios-v1.0b9")
        self.git("-c", "core.hooksPath=/dev/null", "push", "--quiet", "origin", "HEAD:refs/heads/feature")
        for args in (("refs/tags/ios-v1.0b9",), ("--delete", "feature")):
            with self.subTest(args=args):
                result = self.push(*args)
                self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.remote_has("refs/tags/ios-v1.0b9"))
        self.assertFalse(self.remote_has("refs/heads/feature"))
        self.assertEqual(self.checks(), [])

    def test_hosts_without_xcodebuild_skip_the_check(self):
        (self.tools / "xcodebuild").unlink()
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        result = self.push("HEAD:refs/heads/feature", FAIL_CHECK="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.checks(), [])

    def test_a_recorded_pass_for_the_same_files_and_xcode_skips_the_check(self):
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.assertEqual(self.push("HEAD:refs/heads/feature").returncode, 0)
        # Another branch, and a rewritten commit with the same files, reuse the pass.
        result = self.push("HEAD:refs/heads/copy")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("the iOS files in copy passed bin/check-ios with Xcode 27.0 Build version 27A266a",
                      result.stderr)
        self.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--amend", "--message", "Reworded")
        result = self.push("--force", "HEAD:refs/heads/feature", FAIL_CHECK="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.checks()), 1)
        # A different Xcode checks again.
        result = self.push("HEAD:refs/heads/newer", FAKE_XCODE_VERSION="Xcode 27.1\nBuild version 27B5")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.checks()), 2)

    def test_a_pass_older_than_seven_days_does_not_count(self):
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.assertEqual(self.push("HEAD:refs/heads/feature").returncode, 0)
        [path] = self.records()
        entry = json.loads(path.read_text())
        entry["passedAt"] = (datetime.now(timezone.utc) - timedelta(days=7, minutes=1)).isoformat()
        path.write_text(json.dumps(entry))
        result = self.push("HEAD:refs/heads/copy")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.checks()), 2)

    def test_refuses_a_push_the_checkout_cannot_test(self):
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.write("ios/App.swift", "struct App { let draft = true }\n")
        result = self.push("HEAD:refs/heads/feature")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("this checkout's copies differ from the pushed commit", result.stderr)
        self.assertFalse(self.remote_has("refs/heads/feature"))
        # A branch that is not checked out cannot be tested either.
        self.git("checkout", "--quiet", "--", "ios/App.swift")
        self.git("branch", "other")
        self.commit("Edit the app again", ("ios/App.swift", "struct App { let again = true }\n"))
        result = self.push("other:refs/heads/other")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("other changes the iOS files", result.stderr)
        self.assertEqual(self.checks(), [])


if __name__ == "__main__":
    unittest.main()
