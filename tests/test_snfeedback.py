"""Verify bin/snfeedback, ported from PodHaven's bin/tests/test_snfeedback.py, with fake sentry, gh, fzf, and claude."""

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
SCRIPT = ROOT / "bin/snfeedback"
FISH = shutil.which("fish")
# The link that bin/sentry-intake writes, which is also Sentry's permalink.
LINK = "https://artisanal-software.sentry.io/feedback/?feedbackSlug=screenr-ios%3A{}&project=4512251383513088"
FINDINGS = "<!-- analyze-sentry-feedback-findings:start -->\n<!-- analyze-sentry-feedback-findings:end -->"
BOT = {"__typename": "Bot", "login": "github-actions"}
OWNER = {"__typename": "User", "login": "jubishop"}
STRANGER = {"__typename": "User", "login": "stranger"}


def issue(number, state, body, author=OWNER):
    return {"number": number, "title": "", "state": state, "stateReason": None, "body": body, "author": author}


def pages(*nodes):
    """Return gh api graphql --paginate --slurp output for these pages of issues."""
    return [{"data": {"repository": {"issues": {"nodes": page}}}} for page in nodes]


class SentryFeedbackLauncherTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(FISH, "fish is required: bin/snfeedback is a fish script")
        self.temporary = tempfile.TemporaryDirectory(prefix="snfeedback-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.bin = self.directory / "bin"
        self.bin.mkdir()
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith(("GIT_", "SNFEEDBACK_")) and key != "GH_REPO"}
        self.env.update(PATH=str(self.bin), SNFEEDBACK_TEST=str(self.directory))
        for command in ("git", "jq", "seq"):
            (self.bin / command).symlink_to(shutil.which(command))
        (self.bin / "python3").symlink_to(sys.executable)
        for command in ("sentry", "gh", "claude", "fzf"):
            self.stub(command)
        self.write("sentry.json", {
            "data": [
                {"id": "2001", "shortId": "SCREENR-IOS-FA",
                 "metadata": {"message": "Synthetic old report", "contact_email": "old@example.com"}},
                {"id": "2004", "shortId": "SCREENR-IOS-FD",
                 "metadata": {"message": "Synthetic\nnew\treport", "contact_email": None}},
                {"id": "2002", "shortId": "SCREENR-IOS-FB", "title": "Synthetic title fallback",
                 "metadata": {"message": None, "contact_email": None}},
                {"id": "2003", "shortId": "SCREENR-IOS-FC", "metadata": {"message": "Synthetic closed report"}},
            ],
            "hasMore": False,
        })
        self.write("gh.json", pages([
            issue(90, "OPEN", "<!-- sentry-feedback:screenr-ios:2001 -->\n" + FINDINGS, STRANGER),
            issue(99, "OPEN", LINK.format(2004) + "\n" + FINDINGS),
            issue(42, "OPEN", "<!-- sentry-feedback:screenr-ios:2004 -->\n"
                              "<!-- analyze-sentry-feedback-findings:start -->", BOT),
        ], [
            issue(50, "CLOSED", "<!-- sentry-feedback:screenr-ios:2003 -->\n" + FINDINGS, BOT),
            issue(61, "OPEN", LINK.format(2002) + "\n" + FINDINGS),
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

directory = Path(os.environ["SNFEEDBACK_TEST"])
command = Path(sys.argv[0]).name
with (directory / "calls").open("a") as stream:
    stream.write(command + "\\n")
with (directory / (command + ".args")).open("a") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
if os.environ.get("SNFEEDBACK_FAIL") == command:
    raise SystemExit(17)
if command == "claude":
    (directory / "claude.cwd").write_text(json.dumps(os.getcwd()))
elif command == "fzf":
    rows = sys.stdin.read().splitlines()
    (directory / "picker.json").write_text(json.dumps(rows))
    if rows:
        print(rows[int(os.environ.get("SNFEEDBACK_SELECT", "0"))])
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

    def assert_launched(self, result, slug):
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(self.read("claude.cwd"), str(ROOT))
        self.assertEqual(self.arguments("claude")[-1], [
            "--dangerously-skip-permissions",
            f"/analyze-sentry-feedback {slug}",
        ])

    def assert_stopped(self, result, message):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stdout + result.stderr)
        self.assertFalse((self.directory / "claude.args").exists())

    def test_direct_references_launch_from_checkout_root_without_discovery(self):
        for reference in (
            "7485822944",
            "Screenr-iOS:7485822944",
            LINK.format(7485822944),
            LINK.format(7485822944).replace("%3A", "%3a"),
            "https://sentry.io/organizations/artisanal-software/feedback/?project=1&feedbackSlug=SCREENR-IOS:7485822944",
        ):
            with self.subTest(reference=reference):
                self.assert_launched(self.run_command(reference), "screenr-ios:7485822944")
        self.assertEqual(self.calls(), ["claude"] * 5)

    def test_invalid_references_never_launch(self):
        for reference in (
            "screenr-ios:", "other:123", "podhaven:123", "screenr-server:123", "screenr-ios:12a",
            "SCREENR-IOS-3K", "123 extra instructions", "--helpful",
            "https://example.com/?feedbackSlug=screenr-ios:123",
            "https://sentry.io.evil.test/?feedbackSlug=screenr-ios:123",
            "https://evilsentry.io/?feedbackSlug=screenr-ios:123",
            "https://artisanal-software.sentry.io/issues/123/",
            LINK.format("123%26evil"),
        ):
            with self.subTest(reference=reference):
                self.assert_stopped(self.run_command(reference), "not a Screenr feedback slug")
        self.assertEqual(self.calls(), [])

    def test_extra_arguments_show_usage(self):
        self.assert_stopped(self.run_command("2004", "2001"), "Usage: snfeedback")

    def test_picker_sorts_and_shows_reports_and_tracking(self):
        self.assert_launched(self.run_command(), "screenr-ios:2004")
        rows = self.read("picker.json")
        self.assertEqual([row.split("\t", 1)[0] for row in rows],
                         ["screenr-ios:2004", "screenr-ios:2003", "screenr-ios:2002", "screenr-ios:2001"])
        self.assertIn("SCREENR-IOS-FD", rows[0])
        self.assertIn('"Synthetic new report"', rows[0])
        self.assertIn("no contact; GitHub: #42 intake", rows[0])
        self.assertIn("no contact; GitHub: #50 closed", rows[1])
        self.assertIn('"Synthetic title fallback"', rows[2])
        self.assertIn("GitHub: #61 analyzed", rows[2])
        self.assertIn("old@example.com; GitHub: untracked", rows[3])
        self.assertEqual(self.arguments("sentry"), [[
            "issue", "list", "artisanal-software/screenr-ios",
            "--query", "issue.category:feedback is:unresolved",
            "--period", "90d", "--limit", "1000", "--fresh", "--json",
            "--fields", "id,shortId,title,metadata.message,metadata.contact_email",
        ]])
        [gh] = self.arguments("gh")
        self.assertEqual(gh[:8], ["api", "graphql", "--paginate", "--slurp",
                                  "-f", "owner=jubishop", "-f", "name=screenr"])
        self.assertTrue(gh[-1].startswith("query="), gh)
        self.assertEqual(self.calls(), ["sentry", "gh", "fzf", "claude"])

    def test_picker_launches_selected_row(self):
        self.env["SNFEEDBACK_SELECT"] = "2"
        self.assert_launched(self.run_command(), "screenr-ios:2002")

    def test_bare_array_response_and_missing_optional_fields(self):
        self.write("sentry.json", [{"id": "2001"}])
        self.assert_launched(self.run_command(), "screenr-ios:2001")
        [row] = self.read("picker.json")
        self.assertIn("SCREENR-IOS-?", row)
        self.assertIn('"(no message)"', row)
        self.assertIn("no contact; GitHub: untracked", row)

    def test_empty_list_stops_without_fetching_github(self):
        self.write("sentry.json", {"data": [], "hasMore": False})
        self.assert_stopped(self.run_command(), "No unresolved Sentry feedback found")
        self.assertNotIn("gh", self.calls())

    def test_partial_list_is_rejected(self):
        payload = self.read("sentry.json")
        payload["hasMore"] = True
        self.write("sentry.json", payload)
        self.assert_stopped(self.run_command(), "refusing to show a partial list")

    def test_invalid_sentry_data_is_rejected(self):
        for payload, message in (
            ("invalid json", "invalid feedback data"),
            ("", "invalid feedback data"),
            ("{}", "invalid feedback data"),
            ('{"data": {}}', "invalid feedback data"),
            ('{"data": [{"id": "unsafe"}]}', "invalid feedback data"),
            ('{"data": [{"id": "1e3"}]}', "invalid feedback row"),
        ):
            with self.subTest(payload=payload):
                (self.directory / "sentry.json").write_text(payload)
                self.assert_stopped(self.run_command(), message)

    def test_invalid_github_data_is_rejected(self):
        self.write("gh.json", {"error": "synthetic failure"})
        result = self.run_command()
        self.assert_stopped(result, "could not fetch Screenr GitHub issues")
        self.assertIn("unexpected issue list", result.stderr)

    def test_failed_dependencies_and_cancel_never_launch(self):
        for command, message in (
            ("sentry", "could not fetch unresolved Screenr feedback"),
            ("gh", "could not fetch Screenr GitHub issues"),
            ("fzf", "No feedback selected"),
        ):
            with self.subTest(command=command):
                self.env["SNFEEDBACK_FAIL"] = command
                self.assert_stopped(self.run_command(), message)

    def test_missing_commands_never_launch(self):
        for command, arguments, message in (
            ("python3", (), "python3 is required"),
            ("jq", (), "jq is required"),
            ("claude", ("2004",), "claude is required"),
        ):
            with self.subTest(command=command):
                hidden = self.directory / f"hidden-{command}"
                (self.bin / command).rename(hidden)
                self.assert_stopped(self.run_command(*arguments), message)
                hidden.rename(self.bin / command)

    def test_numbered_fallback(self):
        (self.bin / "fzf").unlink()
        result = self.run_command(input="2\n")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.arguments("claude")[-1][-1], "/analyze-sentry-feedback screenr-ios:2003")
        self.assertIn("4. ", result.stdout)

    def test_invalid_numbered_selections(self):
        (self.bin / "fzf").unlink()
        for selection in ("0\n", "5\n", "text\n", ""):
            with self.subTest(selection=selection):
                result = self.run_command(input=selection)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.directory / "claude.args").exists())

    def test_claude_exit_status_is_preserved(self):
        self.env["SNFEEDBACK_FAIL"] = "claude"
        self.assertEqual(self.run_command("2004").returncode, 17)


if __name__ == "__main__":
    unittest.main()
