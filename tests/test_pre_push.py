"""Verify bin/pre-push-application with real pushes to a local remote and a simulated bin/check-ios."""

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
# The simulated check records where it ran, and, like the real one, records a pass with the
# checkout's own bin/_ios_check_records.py when the checkout's iOS files match HEAD. It fails
# when FAIL_CHECK is set.
CHECK_IOS = """import json, os, sys
from pathlib import Path
sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'bin'))
import _ios_check_records as records
with open(os.environ['CHECK_EVENTS'], 'a') as stream:
    stream.write(json.dumps(['check-ios', os.getcwd(), *sys.argv[1:]]) + '\\n')
status = int(os.environ.get('FAIL_CHECK', '0'))
key = records.working_key(root)
if not status and key:
    records.record(root, key, records.xcode_version())
sys.exit(status)
"""
XCODEBUILD = """import os, sys
if sys.argv[1:] != ['-version']:
    sys.exit('unexpected xcodebuild ' + ' '.join(sys.argv[1:]))
print(os.environ.get('FAKE_XCODE_VERSION', 'Xcode 27.0\\nBuild version 27A266a'))
"""
# Stands in for Project Starter's managed bin/hooks/pre-push, which runs the pushing checkout's
# bin/pre-push-application from its root, with Git's arguments, standard input, and environment, once
# its document checks pass.
MANAGED_HOOK = """import pathlib, subprocess, sys
root = pathlib.Path(subprocess.run(['git', 'rev-parse', '--show-toplevel'], check=True,
                                   capture_output=True, text=True).stdout.strip())
sys.exit(subprocess.run([str(root / 'bin/pre-push-application'), *sys.argv[1:]], cwd=root,
                        input=sys.stdin.read(), text=True).returncode)
"""


ADVICE = "Never bypass this check with git push --no-verify."


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
        shutil.copy2(SOURCE / "bin/pre-push-application", self.repo / "bin/pre-push-application")
        self.tool(self.repo / "bin/hooks/pre-push", MANAGED_HOOK)
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

    def write(self, name, text, cwd=None):
        (cwd or self.repo).joinpath(name).write_text(text)

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.repo, env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, message, *changes, cwd=None):
        """Commit every change in the checkout, after writing each named file."""
        for name, text in changes:
            self.write(name, text, cwd)
        self.git("add", "--all", cwd=cwd)
        self.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--message", message, cwd=cwd)
        return self.git("rev-parse", "HEAD", cwd=cwd)

    def hooks_from_this_checkout(self):
        # As on the owner's Mac, where core.hooksPath names the primary checkout's
        # absolute bin/hooks, so Git runs that copy for every worktree.
        self.git("config", "core.hooksPath", str(self.repo / "bin/hooks"))

    def worktree(self):
        path = self.repo.parent / "worktree"
        self.git("worktree", "add", "--quiet", "-b", "feature", str(path))
        return path

    def push(self, *args, cwd=None, **extra):
        return subprocess.run(["git", "push", "origin", *args], cwd=cwd or self.repo,
                              env=self.env | extra, capture_output=True, text=True, timeout=60)

    def check_ios(self, cwd=None, **extra):
        """Run the simulated bin/check-ios from a shell, as an agent does before pushing."""
        root = cwd or self.repo
        return subprocess.run([str(root / "bin/check-ios")], cwd=root, env=self.env | extra,
                              capture_output=True, text=True, timeout=60)

    def remote_has(self, ref):
        return bool(self.git("ls-remote", str(self.remote), ref))

    def checks(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()] if self.events.exists() else []

    def records(self):
        return sorted((self.repo / ".git/screenr-ios-checks").glob("*.json"))

    def test_a_push_without_a_recorded_pass_stops_at_once_without_running_the_check(self):
        # Git connects to the remote before it runs the hook, and GitHub closes an idle SSH
        # connection before a full check finishes, so the hook never runs the check itself.
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        result = self.push("HEAD:refs/heads/feature")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("feature changes the iOS files", result.stderr)
        self.assertIn("Run bin/check-ios in this checkout, which records its pass, then push again.",
                      result.stderr)
        self.assertIn(ADVICE, result.stderr)
        self.assertEqual(self.checks(), [])
        self.assertFalse(self.remote_has("refs/heads/feature"))
        self.assertEqual(self.check_ios().returncode, 0)
        result = self.push("HEAD:refs/heads/feature")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("the iOS files in feature passed bin/check-ios with Xcode 27.0 Build version 27A266a",
                      result.stderr)
        self.assertEqual(self.checks(), [["check-ios", str(self.repo)]])
        self.assertTrue(self.remote_has("refs/heads/feature"))

    def refused(self, result, branch):
        """Assert that the hook refused a push of the branch's iOS files before sending anything."""
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"{branch} changes the iOS files", result.stderr)
        self.assertIn("so the push stopped before sending anything", result.stderr)
        self.assertIn(ADVICE, result.stderr)
        self.assertFalse(self.remote_has(f"refs/heads/{branch}"))

    def test_a_push_from_a_linked_worktree_uses_the_passes_every_worktree_shares(self):
        worktree = self.worktree()
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"), cwd=worktree)
        self.refused(self.push("HEAD:refs/heads/feature", cwd=worktree), "feature")
        self.assertEqual(self.check_ios(cwd=worktree).returncode, 0)
        result = self.push("HEAD:refs/heads/feature", cwd=worktree)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.remote_has("refs/heads/feature"))
        # The pass lives in the clone's Git directory, so this checkout reuses it.
        self.assertEqual(len(self.records()), 1)
        result = self.push("feature:refs/heads/copy")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.checks(), [["check-ios", str(worktree)]])

    def test_a_worktree_uses_its_own_modules_when_hooks_come_from_this_checkout(self):
        # The hook imports bin/_ios_check_records.py from beside itself, so the
        # worktree's copy reads the pass where the worktree's own module stores it.
        self.hooks_from_this_checkout()
        worktree = self.worktree()
        module = (worktree / "bin/_ios_check_records.py").read_text()
        self.assertIn('STORE = "screenr-ios-checks"\n', module)
        self.commit("Store passes elsewhere",
                    ("bin/_ios_check_records.py", module.replace('STORE = "screenr-ios-checks"',
                                                                 'STORE = "screenr-ios-checks-v2"')),
                    ("ios/App.swift", "struct App { let edited = true }\n"), cwd=worktree)
        self.assertEqual(self.check_ios(cwd=worktree).returncode, 0)
        result = self.push("HEAD:refs/heads/feature", cwd=worktree)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.records(), [])
        self.assertEqual(len(list((self.repo / ".git/screenr-ios-checks-v2").glob("*.json"))), 1)

    def test_a_refspec_with_spaces_still_needs_a_pass(self):
        # Git passes the local side as typed, so this line has more than four words.
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.refused(self.push(":/Edit the app:refs/heads/feature"), "feature")
        self.assertEqual(self.check_ios().returncode, 0)
        result = self.push(":/Edit the app:refs/heads/feature")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.remote_has("refs/heads/feature"))

    def test_unreadable_input_refuses_the_push(self):
        head = self.git("rev-parse", "HEAD")
        for line in ("garbage", f"HEAD {head} refs/heads/main", f"HEAD abc refs/heads/main {head}",
                     f"HEAD {head} refs/heads/main {head.upper()}"):
            with self.subTest(line=line):
                result = subprocess.run([str(self.repo / "bin/pre-push-application"), "origin", str(self.remote)],
                                        cwd=self.repo, env=self.env, input=line + "\n", capture_output=True,
                                        text=True, timeout=60)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"cannot read the pushed refs from {line!r}", result.stderr)
                self.assertIn(ADVICE, result.stderr)
        self.assertEqual(self.checks(), [])

    def test_bin_format_swift_counts_as_an_ios_file_but_bin_check_ios_does_not(self):
        # The simulated check keeps working when its file changes.
        self.commit("Check differently", ("bin/check-ios", "#!" + sys.executable + "\n# v2\n" + CHECK_IOS))
        result = self.push("HEAD:refs/heads/check")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.commit("Format differently", ("bin/format-swift", "#!/bin/sh\n# stricter\n"))
        self.refused(self.push("HEAD:refs/heads/format"), "format")
        self.assertEqual(self.checks(), [])

    def test_a_failing_check_records_no_pass_so_the_push_stays_refused(self):
        self.commit("Break the app", ("ios/App.swift", "struct App { broken }\n"))
        self.assertNotEqual(self.check_ios(FAIL_CHECK="1").returncode, 0)
        self.assertEqual(self.records(), [])
        self.refused(self.push("HEAD:refs/heads/feature"), "feature")
        result = self.push("HEAD:refs/heads/main")
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

    def test_markdown_directly_in_ios_is_not_an_ios_file(self):
        self.commit("Document the app", ("ios/README.md", "# The iPhone app\n"),
                    ("ios/AGENTS.md", "# Rules\n"))
        result = self.push("HEAD:refs/heads/docs")
        self.assertEqual(result.returncode, 0, result.stderr)
        # Uncommitted Markdown there does not stop this checkout from checking the pushed commit.
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.write("ios/README.md", "# Draft\n")
        result = self.push("HEAD:refs/heads/feature")
        self.refused(result, "feature")
        self.assertIn("Run bin/check-ios in this checkout", result.stderr)
        self.assertEqual(self.check_ios().returncode, 0)
        result = self.push("HEAD:refs/heads/feature")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.checks()), 1)
        self.assertEqual(len(self.records()), 1)

    def test_markdown_in_a_folder_under_ios_is_an_ios_file(self):
        # SwiftPM targets and Xcode's synchronized folders build every file in them, and
        # SwiftPM warns about Markdown it does not handle.
        for name in ("ios/ScreenrKit/Sources/ScreenrKit/Notes.md", "ios/Screenr/Notes.md"):
            with self.subTest(name=name):
                (self.repo / name).parent.mkdir(parents=True, exist_ok=True)
                self.commit("Add notes", (name, "Notes.\n"))
                self.refused(self.push("HEAD:refs/heads/notes"), "notes")
                self.git("reset", "--quiet", "--hard", "HEAD~1")

    def test_an_existing_branch_compares_with_its_remote_commit(self):
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.assertEqual(self.check_ios().returncode, 0)
        self.assertEqual(self.push("HEAD:refs/heads/feature").returncode, 0)
        shutil.rmtree(self.repo / ".git/screenr-ios-checks")
        self.commit("Edit the web", ("src/page.ts", "export const page = 2;\n"))
        result = self.push("HEAD:refs/heads/feature")
        self.assertEqual(result.returncode, 0, result.stderr)

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

    def test_hosts_without_xcodebuild_skip_the_check(self):
        (self.tools / "xcodebuild").unlink()
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        result = self.push("HEAD:refs/heads/feature")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_recorded_pass_for_the_same_files_and_xcode_counts(self):
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.assertEqual(self.check_ios().returncode, 0)
        self.assertEqual(self.push("HEAD:refs/heads/feature").returncode, 0)
        # Another branch, and a rewritten commit with the same files, reuse the pass.
        result = self.push("HEAD:refs/heads/copy")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("the iOS files in copy passed bin/check-ios with Xcode 27.0 Build version 27A266a",
                      result.stderr)
        self.git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--amend", "--message", "Reworded")
        result = self.push("--force", "HEAD:refs/heads/feature")
        self.assertEqual(result.returncode, 0, result.stderr)
        # A different Xcode needs its own pass.
        newer = "Xcode 27.1\nBuild version 27B5"
        result = self.push("HEAD:refs/heads/newer", FAKE_XCODE_VERSION=newer)
        self.refused(result, "newer")
        self.assertIn("no bin/check-ios pass with Xcode 27.1 Build version 27B5 in the last 7 days", result.stderr)
        self.assertEqual(self.check_ios(FAKE_XCODE_VERSION=newer).returncode, 0)
        result = self.push("HEAD:refs/heads/newer", FAKE_XCODE_VERSION=newer)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.checks()), 2)

    def test_a_pass_older_than_seven_days_does_not_count(self):
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.assertEqual(self.check_ios().returncode, 0)
        self.assertEqual(self.push("HEAD:refs/heads/feature").returncode, 0)
        [path] = self.records()
        entry = json.loads(path.read_text())
        entry["passedAt"] = (datetime.now(timezone.utc) - timedelta(days=7, minutes=1)).isoformat()
        path.write_text(json.dumps(entry))
        self.refused(self.push("HEAD:refs/heads/copy"), "copy")

    def test_the_refusal_says_to_check_out_a_commit_the_checkout_does_not_match(self):
        self.commit("Edit the app", ("ios/App.swift", "struct App { let edited = true }\n"))
        self.write("ios/App.swift", "struct App { let draft = true }\n")
        result = self.push("HEAD:refs/heads/feature")
        self.refused(result, "feature")
        self.assertIn("This checkout's iOS files differ from the pushed commit, so check out the commit you are "
                      "pushing with no uncommitted iOS changes, run bin/check-ios there", result.stderr)
        # A branch that is not checked out cannot be checked here either.
        self.git("checkout", "--quiet", "--", "ios/App.swift")
        self.git("branch", "other")
        self.commit("Edit the app again", ("ios/App.swift", "struct App { let again = true }\n"))
        result = self.push("other:refs/heads/other")
        self.refused(result, "other")
        self.assertIn("This checkout's iOS files differ from the pushed commit", result.stderr)
        # Once a commit's iOS files passed, the checkout's state no longer matters.
        self.git("checkout", "--quiet", "other")
        self.assertEqual(self.check_ios().returncode, 0)
        self.git("checkout", "--quiet", "main")
        self.write("ios/App.swift", "struct App { let draft = true }\n")
        result = self.push("other:refs/heads/other")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.checks()), 1)


if __name__ == "__main__":
    unittest.main()
