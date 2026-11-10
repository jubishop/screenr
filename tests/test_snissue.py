"""Verify bin/snissue, ported from PodHaven's bin/tests/test_snissue.py, with fake sentry, gh, fzf, and claude."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from _process_waits import HANG_SECONDS


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "bin/snissue"
FISH = shutil.which("fish")
FINDINGS = "<!-- analyze-sentry-issue-findings:start -->\n<!-- analyze-sentry-issue-findings:end -->"
BOT = {"__typename": "Bot", "login": "github-actions"}
OWNER = {"__typename": "User", "login": "jubishop"}
STRANGER = {"__typename": "User", "login": "stranger"}


def issue(number, state, body, author=OWNER, title=""):
    return {"number": number, "title": title, "state": state, "stateReason": None, "body": body, "author": author}


def pages(*nodes):
    """Return gh api graphql --paginate --slurp output for these pages of issues."""
    return [{"data": {"repository": {"issues": {"nodes": page}}}} for page in nodes]


class SentryIssueLauncherTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(FISH, "fish is required: bin/snissue is a fish script")
        self.temporary = tempfile.TemporaryDirectory(prefix="snissue-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("GIT_", "SNISSUE_")) and key != "GH_REPO"}
        self.env.update(PATH=str(self.bin), SNISSUE_TEST=str(self.directory))
        for command in ("git", "jq", "seq"):
            (self.bin / command).symlink_to(shutil.which(command))
        (self.bin / "python3").symlink_to(sys.executable)
        for command in ("sentry", "gh", "claude", "fzf"):
            self.stub(command)
        self.write("sentry-screenr-ios.json", {
            "data": [
                {"id": "1001", "shortId": "SCREENR-IOS-A", "title": "Synthetic old issue",
                 "level": "warning", "count": "12", "userCount": 3},
                {"id": "1003", "shortId": "SCREENR-IOS-C", "title": "Synthetic\nnew\tissue",
                 "level": "error", "count": "4", "userCount": 2},
            ],
            "hasMore": False,
        })
        self.write("sentry-screenr-server.json", {
            "data": [{"id": "1002", "shortId": "SCREENR-SERVER-B", "title": "Synthetic middle issue"}],
            "hasMore": False,
            "hasPrev": False,
        })
        self.write("gh.json", pages([
            issue(90, "OPEN", "<!-- sentry-issue:1003 -->\n" + FINDINGS, STRANGER),
            issue(91, "OPEN", "", title="SCREENR-IOS-C0"),
            issue(92, "OPEN", "https://artisanal-software.sentry.io/issues/10030/"),
            issue(93, "OPEN", "Reference only", title="SCREENR-IOS-C"),
            issue(41, "CLOSED", "<!-- sentry-issue:1001 -->\n" + FINDINGS),
        ], [
            issue(42, "CLOSED", "https://artisanal-software.sentry.io/issues/1003/?query=is%3Aunresolved"),
            issue(43, "OPEN", None, title="Investigate SCREENR-IOS-A"),
            issue(44, "OPEN", "<!-- sentry-issue:1002 -->\n<!-- analyze-sentry-issue-findings:start -->", BOT),
            issue(45, "OPEN", "https://artisanal-software.sentry.io/issues/1001/\n\n## Sentry closeout\n"),
        ]))

    def write(self, name, value):
        (self.directory / name).write_text(json.dumps(value))

    def read(self, name):
        return json.loads((self.directory / name).read_text())

    def calls(self):
        path = self.directory / "calls"
        return path.read_text().splitlines() if path.exists() else []

    def arguments(self, command):
        return [json.loads(line) for line in (self.directory / f"{command}.args").read_text().splitlines()]

    def stub(self, command):
        path = self.bin / command
        path.write_text(f"#!{sys.executable}\n" + '''
import json
import os
from pathlib import Path
import sys

directory = Path(os.environ["SNISSUE_TEST"])
command = Path(sys.argv[0]).name
with (directory / "calls").open("a") as stream:
    stream.write(command + "\\n")
with (directory / (command + ".args")).open("a") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
project = sys.argv[3].partition("/")[2] if command == "sentry" else ""
if os.environ.get("SNISSUE_FAIL") in (command, command + ":" + project):
    raise SystemExit(17)
if command == "claude":
    (directory / "claude.cwd").write_text(json.dumps(os.getcwd()))
elif command == "fzf":
    rows = sys.stdin.read().splitlines()
    (directory / "picker.json").write_text(json.dumps(rows))
    if rows:
        print(rows[int(os.environ.get("SNISSUE_SELECT", "0"))])
elif command == "sentry":
    print((directory / ("sentry-" + project + ".json")).read_text())
else:
    print((directory / (command + ".json")).read_text())
''')
        path.chmod(0o755)

    def run_command(self, *arguments, input=None):
        return subprocess.run(
            [FISH, "--no-config", str(SCRIPT), *arguments],
            cwd=ROOT / "tests", env=self.env,
            input=input, text=True, capture_output=True, timeout=HANG_SECONDS,
        )

    def assert_launched(self, result, reference):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.read("claude.cwd"), str(ROOT))
        self.assertEqual(self.arguments("claude")[-1], [
            "--dangerously-skip-permissions",
            f"/analyze-sentry-issue {reference}",
        ])

    def assert_stopped(self, result, message):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stdout + result.stderr)
        self.assertFalse((self.directory / "claude.args").exists())

    def test_direct_references_launch_from_checkout_root_without_discovery(self):
        for reference, expected in (
            ("1003", "1003"),
            ("screenr-ios-c", "SCREENR-IOS-C"),
            ("Screenr-Server-1", "SCREENR-SERVER-1"),
            ("https://artisanal-software.sentry.io/issues/1003/?query=is%3Aunresolved", "1003"),
            ("https://sentry.io/organizations/artisanal-software/issues/1003/", "1003"),
        ):
            with self.subTest(reference=reference):
                self.assert_launched(self.run_command(reference), expected)
        self.assertEqual(self.calls(), ["claude"] * 5)

    def test_invalid_references_never_launch(self):
        for reference in (
            "SCREENR-IOS-", "SCREENR-AC", "OTHER-AC", "PODHAVEN-AC", "1003 extra instructions", "--helpful",
            "https://example.com/issues/1003/", "https://sentry.io.evil.test/issues/1003/",
            "https://artisanal-software.sentry.io/feedback/?feedbackSlug=screenr-ios%3A1003",
            "https://artisanal-software.sentry.io/issues/1003evil/",
        ):
            with self.subTest(reference=reference):
                self.assert_stopped(self.run_command(reference), "not a Screenr issue")
        self.assertEqual(self.calls(), [])

    def test_help_and_extra_arguments(self):
        for flag in ("--help", "-h"):
            result = self.run_command(flag)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Usage: snissue", result.stdout)
        self.assert_stopped(self.run_command("1003", "1001"), "Usage: snissue")

    def test_picker_merges_both_projects_newest_first_with_impact_and_tracking(self):
        self.assert_launched(self.run_command(), "1003")
        rows = self.read("picker.json")
        self.assertEqual([row.split("\t", 1)[0] for row in rows], ["1003", "1002", "1001"])
        self.assertIn("SCREENR-IOS-C", rows[0])
        self.assertIn("Synthetic new issue", rows[0])
        self.assertIn("4 events; 2 users", rows[0])
        self.assertIn("GitHub: #42 closed", rows[0])
        self.assertIn("SCREENR-SERVER-B", rows[1])
        self.assertIn("GitHub: #44 intake", rows[1])
        self.assertIn("GitHub: #45 analyzed", rows[2])
        self.assertEqual(self.arguments("sentry"), [[
            "issue", "list", f"artisanal-software/{project}",
            "--query", "is:unresolved !issue.category:feedback",
            "--period", "90d", "--limit", "1000", "--sort", "new", "--fresh", "--json",
            "--fields", "id,shortId,title,level,count,userCount",
        ] for project in ("screenr-ios", "screenr-server")])
        [gh] = self.arguments("gh")
        self.assertEqual(gh[:8], ["api", "graphql", "--paginate", "--slurp",
                                  "-f", "owner=jubishop", "-f", "name=screenr"])
        self.assertTrue(gh[-1].startswith("query="), gh)
        self.assertEqual(self.calls(), ["sentry", "sentry", "gh", "fzf", "claude"])

    def test_mentions_and_untrusted_authors_do_not_track(self):
        self.write("gh.json", pages([
            issue(90, "OPEN", "<!-- sentry-issue:1003 -->\n" + FINDINGS, STRANGER),
            issue(91, "OPEN", "https://artisanal-software.sentry.io/issues/1003/", None),
            issue(93, "OPEN", "Reference only", title="SCREENR-IOS-C"),
        ]))
        self.assert_launched(self.run_command(), "1003")
        self.assertIn("GitHub: untracked", self.read("picker.json")[0])

    def test_picker_launches_selected_row(self):
        self.env["SNISSUE_SELECT"] = "2"
        self.assert_launched(self.run_command(), "1001")

    def test_bare_array_response_and_missing_optional_fields(self):
        self.write("sentry-screenr-ios.json", [{"id": "1001"}])
        self.write("sentry-screenr-server.json", [])
        self.assert_launched(self.run_command(), "1001")
        [row] = self.read("picker.json")
        self.assertIn("SCREENR-?", row)
        self.assertIn("(no title)", row)
        self.assertIn("unknown; ? events; ? users", row)

    def test_empty_lists_do_not_fetch_github(self):
        for project in ("screenr-ios", "screenr-server"):
            self.write(f"sentry-{project}.json", {"data": [], "hasMore": False})
        self.assert_stopped(self.run_command(), "No unresolved Sentry issues found")
        self.assertNotIn("gh", self.calls())

    def test_partial_list_in_either_project_is_rejected(self):
        for project in ("screenr-ios", "screenr-server"):
            with self.subTest(project=project):
                name = f"sentry-{project}.json"
                original = self.read(name)
                self.write(name, original | {"hasMore": True})
                self.assert_stopped(self.run_command(), f"more than 1000 unresolved {project} issues")
                self.assertNotIn("gh", self.calls())
                self.write(name, original)

    def test_invalid_sentry_data_is_rejected(self):
        for project in ("screenr-ios", "screenr-server"):
            for payload in ("invalid json", "", "{}", '{"data": {}}', '{"data": [{"id": "unsafe"}]}'):
                with self.subTest(project=project, payload=payload):
                    path = self.directory / f"sentry-{project}.json"
                    original = path.read_text()
                    path.write_text(payload)
                    self.assert_stopped(self.run_command(), "invalid issue data")
                    path.write_text(original)

    def test_invalid_github_data_is_rejected(self):
        self.write("gh.json", {"error": "synthetic failure"})
        result = self.run_command()
        self.assert_stopped(result, "could not fetch Screenr GitHub issues")
        self.assertIn("unexpected issue list", result.stderr)

    def test_failed_dependencies_and_cancel_never_launch(self):
        for failure, message in (
            ("sentry:screenr-ios", "could not fetch unresolved screenr-ios issues"),
            ("sentry:screenr-server", "could not fetch unresolved screenr-server issues"),
            ("gh", "could not fetch Screenr GitHub issues"),
            ("fzf", "No issue selected"),
        ):
            with self.subTest(failure=failure):
                self.env["SNISSUE_FAIL"] = failure
                self.assert_stopped(self.run_command(), message)

    def test_missing_commands_never_launch(self):
        for command, arguments, message in (
            ("python3", (), "python3 is required"),
            ("jq", (), "jq is required"),
            ("claude", ("1003",), "claude is required"),
        ):
            with self.subTest(command=command):
                hidden = self.directory / f"hidden-{command}"
                (self.bin / command).rename(hidden)
                self.assert_stopped(self.run_command(*arguments), message)
                hidden.rename(self.bin / command)

    def test_numbered_fallback(self):
        (self.bin / "fzf").unlink()
        result = self.run_command(input="2\n")
        self.assert_launched(result, "1002")
        self.assertIn("1. ", result.stdout)
        self.assertIn("3. ", result.stdout)

    def test_invalid_numbered_selections(self):
        (self.bin / "fzf").unlink()
        for selection in ("0\n", "4\n", "text\n", ""):
            with self.subTest(selection=selection):
                result = self.run_command(input=selection)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.directory / "claude.args").exists())

    def test_claude_exit_status_is_preserved(self):
        self.env["SNISSUE_FAIL"] = "claude"
        self.assertEqual(self.run_command("1003").returncode, 17)


if __name__ == "__main__":
    unittest.main()
