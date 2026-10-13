"""File Sentry feedback as GitHub issues through fake Sentry and GitHub boundaries."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit


ROOT = Path(__file__).resolve().parents[1]
API = "/api/0/organizations/artisanal-software"
PROJECT_ID = "4512251383513088"

# What members write, who they are, and what they attach. None of it may
# reach GitHub or the workflow log.
MEMBER_TEXT = "Alice spoiled the finale of Severance for Bob"
PRIVATE = (MEMBER_TEXT, "Alice Example", "alice@example.com", "screenshot.png",
           "log tail: opened title 1396")

# Stands in for the GitHub CLI: logs each call with its standard input, lists
# the fixture's issues as slurped GraphQL pages, and files new issues there.
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
base = Path(os.environ["FIXTURE"])
args = sys.argv[1:]
stdin = "" if sys.stdin.isatty() else sys.stdin.read()
with (base / "gh-calls").open("a") as log:
    log.write(json.dumps({"args": args, "stdin": stdin}) + "\n")
issues = json.loads((base / "issues.json").read_text())
if args[:2] == ["api", "graphql"]:
    pages = [issues[start:start + 100] for start in range(0, max(len(issues), 1), 100)]
    print(json.dumps([{"data": {"repository": {"issues": {"nodes": page}}}} for page in pages]))
elif args[:2] == ["issue", "create"]:
    if (base / "fail-create").exists():
        sys.exit(1)
    number = max([issue["number"] for issue in issues] + [300]) + 1
    issues.append({"number": number, "body": stdin})
    (base / "issues.json").write_text(json.dumps(issues))
    print(f"https://github.com/jubishop/screenr/issues/{number}")
else:
    sys.exit(2)
'''


def feedback(issue_id, short_id, first_seen="2026-10-13T17:30:00Z"):
    """Return a Sentry feedback issue as the issues API lists it, with member content."""
    return {
        "id": issue_id, "shortId": short_id, "firstSeen": first_seen, "lastSeen": first_seen,
        "title": MEMBER_TEXT, "culprit": "user.feedback", "status": "unresolved",
        "issueCategory": "feedback", "issueType": "feedback",
        "permalink": f"https://artisanal-software.sentry.io/feedback/?feedbackSlug=screenr-ios%3A{issue_id}",
        "metadata": {"message": MEMBER_TEXT, "name": "Alice Example",
                     "contact_email": "alice@example.com", "title": "User Feedback"},
    }


def event(release="com.artisanalsoftware.Screenr@1.2+42", dist="42"):
    """Return a feedback issue's latest event, with member content beside its tags."""
    tags = [{"key": "level", "value": "info"}, {"key": "user.email", "value": "alice@example.com"}]
    if release is not None:
        tags.append({"key": "release", "value": release})
    if dist is not None:
        tags.append({"key": "dist", "value": dist})
    return {
        "message": MEMBER_TEXT, "title": MEMBER_TEXT, "tags": tags,
        "user": {"id": "member-7", "email": "alice@example.com", "name": "Alice Example"},
        "contexts": {"feedback": {"message": MEMBER_TEXT, "contact_email": "alice@example.com",
                                  "name": "Alice Example"}},
        "entries": [{"type": "attachments", "data": {"name": "screenshot.png"}},
                    {"type": "message", "data": {"formatted": "log tail: opened title 1396"}}],
    }


class FakeSentry(BaseHTTPRequestHandler):
    """Serve canned Sentry API responses keyed by path and cursor."""

    def do_GET(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        self.server.requests.append({"path": url.path, "query": query,
                                     "authorization": self.headers.get("Authorization")})
        key = (url.path, query.get("cursor", [None])[0])
        status, body, link = self.server.responses.get(key, (404, {"detail": "Not found"}, None))
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        if link:
            self.send_header("Link", link)
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class SentryFeedbackIssueTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.fixture = Path(temporary.name)
        commands = self.fixture / "commands"
        commands.mkdir()
        (commands / "gh").write_text(FAKE_GH)
        (commands / "gh").chmod(0o755)
        self.issues([])

        self.sentry = ThreadingHTTPServer(("127.0.0.1", 0), FakeSentry)
        self.sentry.requests, self.sentry.responses = [], {}
        thread = threading.Thread(target=self.sentry.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.sentry.server_close)
        self.addCleanup(self.sentry.shutdown)
        self.base = f"http://127.0.0.1:{self.sentry.server_address[1]}"

        environment = {key: value for key, value in os.environ.items()
                       if key not in {"GITHUB_STEP_SUMMARY", "GH_REPO"}}
        self.environment = {**environment, "FIXTURE": str(self.fixture),
                            "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                            "SENTRY_API_URL": self.base + "/api/0",
                            "SENTRY_AUTH_TOKEN": "sentry-test-token", "no_proxy": "*"}

    def issues(self, issues):
        (self.fixture / "issues.json").write_text(json.dumps(issues))

    def filed_issues(self):
        return json.loads((self.fixture / "issues.json").read_text())

    def feedback_pages(self, *pages):
        """Serve the feedback list as pages linked by Sentry cursors."""
        path = f"{API}/issues/"
        for index, page in enumerate(pages):
            cursor = None if index == 0 else f"0:{index * 100}:0"
            following = f"0:{(index + 1) * 100}:0"
            more = "true" if index + 1 < len(pages) else "false"
            link = (f'<{self.base}{path}?cursor=0:0:1>; rel="previous"; results="false"; '
                    f'cursor="0:0:1", <{self.base}{path}?project={PROJECT_ID}&cursor={following}>; '
                    f'rel="next"; results="{more}"; cursor="{following}"')
            self.sentry.responses[(path, cursor)] = (200, page, link)

    def latest_event(self, issue_id, body, status=200):
        self.sentry.responses[(f"{API}/issues/{issue_id}/events/latest/", None)] = (status, body, None)

    def gh_calls(self):
        path = self.fixture / "gh-calls"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def created(self):
        return [call for call in self.gh_calls() if call["args"][:2] == ["issue", "create"]]

    def run_command(self, *args, status=0, environment=None):
        result = subprocess.run(
            [sys.executable, str(ROOT / "bin/sentry-feedback-issues"), *args],
            env=environment or self.environment, stdin=subprocess.DEVNULL, capture_output=True,
            text=True, timeout=60,
        )
        self.assertEqual(result.returncode, status, result.stderr)
        return result

    def assert_no_member_content(self, result):
        published = json.dumps(self.gh_calls()) + result.stdout + result.stderr
        for private in PRIVATE:
            self.assertNotIn(private, published)

    def test_files_one_labeled_issue_with_only_the_link_date_and_build(self):
        self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1", "2026-10-14T03:00:00Z")])
        self.latest_event("7768802020", event())

        result = self.run_command()

        [call] = self.created()
        args = call["args"]
        self.assertEqual(args[args.index("--repo") + 1], "jubishop/screenr")
        self.assertEqual(args[args.index("--title") + 1], "Triage Sentry feedback SCREENR-IOS-1")
        self.assertEqual(args[args.index("--body-file") + 1], "-")
        self.assertEqual([args[index + 1] for index, arg in enumerate(args) if arg == "--label"],
                         ["investigation", "area: ios"])
        self.assertEqual(call["stdin"], (
            "<!-- sentry-feedback:screenr-ios:7768802020 -->\n"
            "- **Feedback:** [SCREENR-IOS-1](https://artisanal-software.sentry.io/feedback/"
            "?feedbackSlug=screenr-ios%3A7768802020&project=4512251383513088)\n"
            # 03:00 UTC on October 14 is still October 13 in Pacific time.
            "- **Date:** 2026-10-13 (Pacific)\n"
            "- **Build:** `com.artisanalsoftware.Screenr@1.2+42` (dist `42`)\n"
            "\n"
            "This repository is public. Read the feedback in Sentry, and describe it here "
            "only in paraphrase without names.\n"
        ))
        self.assertIn("issues/301", result.stdout)
        self.assert_no_member_content(result)

    def test_rerun_files_no_duplicate(self):
        self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1")])
        self.latest_event("7768802020", event())

        self.run_command()
        result = self.run_command()

        self.assertEqual(len(self.created()), 1)
        self.assertEqual(len(self.filed_issues()), 1)
        self.assertIn("Already filed: SCREENR-IOS-1 in #301", result.stdout)

    def test_skips_feedback_filed_in_open_or_closed_issues_without_reading_it(self):
        link = ("https://artisanal-software.sentry.io/feedback/"
                "?feedbackSlug=screenr-ios%3A7768800421&project=4512251383513088")
        self.issues([
            {"number": 12, "body": None},
            {"number": 40, "body": "<!-- sentry-feedback:screenr-ios:7768802020 -->\nClosed."},
            # A maintainer removed the marker but kept the link.
            {"number": 41, "body": f"- **Feedback:** [SCREENR-IOS-2]({link})"},
            # Another feedback ID that merely starts with a pending one.
            {"number": 42, "body": "<!-- sentry-feedback:screenr-ios:77688 -->"},
        ])
        self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1"),
                             feedback("7768800421", "SCREENR-IOS-2"),
                             feedback("776880", "SCREENR-IOS-3")])
        self.latest_event("776880", event())

        result = self.run_command()

        [call] = self.created()
        self.assertIn("screenr-ios:776880 -->", call["stdin"])
        self.assertIn("Already filed: SCREENR-IOS-1 in #40", result.stdout)
        self.assertIn("Already filed: SCREENR-IOS-2 in #41", result.stdout)
        fetched = [request["path"] for request in self.sentry.requests if "/events/" in request["path"]]
        self.assertEqual(fetched, [f"{API}/issues/776880/events/latest/"])
        # One batched listing of every issue, whatever the feedback count.
        self.assertEqual([call["args"][:4] for call in self.gh_calls() if call["args"][0] == "api"],
                         [["api", "graphql", "--paginate", "--slurp"]])

    def test_reads_every_page_of_unresolved_feedback_and_files_oldest_first(self):
        self.feedback_pages([feedback("900", "SCREENR-IOS-9")], [feedback("100", "SCREENR-IOS-4")])
        self.latest_event("900", event())
        self.latest_event("100", event())

        self.run_command()

        self.assertEqual([call["args"][call["args"].index("--title") + 1] for call in self.created()],
                         ["Triage Sentry feedback SCREENR-IOS-4", "Triage Sentry feedback SCREENR-IOS-9"])
        listings = [request for request in self.sentry.requests if request["path"] == f"{API}/issues/"]
        self.assertEqual(len(listings), 2)
        first = listings[0]
        self.assertEqual(first["query"]["project"], [PROJECT_ID])
        self.assertEqual(first["query"]["query"], ["issue.category:feedback is:unresolved"])
        for request in self.sentry.requests:
            self.assertEqual(request["authorization"], "Bearer sentry-test-token")

    def test_build_shows_only_well_formed_release_and_dist(self):
        cases = (
            ("release only", event(dist=None), "`com.artisanalsoftware.Screenr@1.2+42`"),
            ("no build tags", event(release=None, dist=None), "unknown"),
            ("member text in tags", event(release=MEMBER_TEXT, dist="Alice Example"), "unknown"),
            ("unexpected event", {"tags": "release"}, "unknown"),
        )
        for index, (name, body, build) in enumerate(cases):
            with self.subTest(name):
                issue_id = str(500 + index)
                self.feedback_pages([feedback(issue_id, f"SCREENR-IOS-{issue_id}")])
                self.latest_event(issue_id, body)
                result = self.run_command()
                self.assertIn(f"- **Build:** {build}\n", self.created()[-1]["stdin"])
                self.assert_no_member_content(result)

    def test_no_feedback_reads_no_github_issues(self):
        self.feedback_pages([])

        result = self.run_command()

        self.assertEqual(self.gh_calls(), [])
        self.assertIn("Found 0 unresolved feedback item(s)", result.stdout)

    def test_dry_run_files_nothing(self):
        self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1")])
        self.latest_event("7768802020", event())

        result = self.run_command("--dry-run")

        self.assertEqual(self.created(), [])
        self.assertIn("Would file: Triage Sentry feedback SCREENR-IOS-1", result.stdout)

    def test_unexpected_sentry_responses_file_nothing(self):
        cases = {
            "non-numeric ID": [feedback("77x", "SCREENR-IOS-1")],
            "member text as short ID": [feedback("7768802020", MEMBER_TEXT)],
            "timestamp without zone": [feedback("7768802020", "SCREENR-IOS-1", "2026-10-13T17:30:00")],
            "object instead of list": {"detail": MEMBER_TEXT},
        }
        for name, page in cases.items():
            with self.subTest(name):
                self.feedback_pages(page)
                self.latest_event("7768802020", event())
                result = self.run_command(status=1)
                self.assertIn("unexpected", result.stderr)
                self.assertEqual(self.created(), [])
                self.assert_no_member_content(result)

    def test_sentry_and_github_failures_exit_with_an_error(self):
        self.sentry.responses[(f"{API}/issues/", None)] = (401, {"detail": MEMBER_TEXT}, None)
        result = self.run_command(status=1)
        self.assertIn("HTTP 401", result.stderr)
        self.assertEqual(self.gh_calls(), [])
        self.assert_no_member_content(result)

        self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1")])
        self.latest_event("7768802020", event())
        (self.fixture / "fail-create").touch()
        self.run_command(status=1)
        self.assertEqual(self.filed_issues(), [])

    def test_next_page_on_another_host_is_refused(self):
        path = f"{API}/issues/"
        link = '<https://attacker.example/api/0/issues/?cursor=1>; rel="next"; results="true"'
        self.sentry.responses[(path, None)] = (200, [], link)
        result = self.run_command(status=1)
        self.assertIn("unexpected", result.stderr)

    def test_requires_a_sentry_token(self):
        environment = {**self.environment, "SENTRY_AUTH_TOKEN": ""}
        result = self.run_command(status=1, environment=environment)
        self.assertIn("SENTRY_AUTH_TOKEN", result.stderr)
        self.assertEqual(self.sentry.requests, [])


if __name__ == "__main__":
    unittest.main()
