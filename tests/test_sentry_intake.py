"""Track Sentry feedback and error issues in GitHub issues through fake Sentry and GitHub boundaries."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlencode, urlsplit

from _process_waits import HANG_SECONDS


ROOT = Path(__file__).resolve().parents[1]
API = "/api/0/organizations/artisanal-software"
IOS = "4512251383513088"
SERVER = "4512251383578624"
FEEDBACK_QUERY = "issue.category:feedback is:unresolved"
ERROR_QUERY = "is:unresolved !issue.category:feedback"

# What members write, who they are, what they attach, and what errors say.
# None of it may reach GitHub or the workflow log.
MEMBER_TEXT = "Alice spoiled the finale of Severance for Bob"
ERROR_TEXT = "Could not load the review that alice wrote of title 1396"
PRIVATE = (MEMBER_TEXT, ERROR_TEXT, "Alice Example", "alice@example.com", "screenshot.png",
           "log tail: opened title 1396", "TitleReviewView.load")

# The account that files issues in the workflow, as GraphQL names it.
ACTIONS_BOT = {"__typename": "Bot", "login": "github-actions"}
OWNER = {"__typename": "User", "login": "jubishop"}
STRANGER = {"__typename": "User", "login": "stranger"}

FEEDBACK_FINDINGS = ("<!-- analyze-sentry-feedback-findings:start -->\n## Findings\n"
                     "<!-- analyze-sentry-feedback-findings:end -->")
ERROR_FINDINGS = ("<!-- analyze-sentry-issue-findings:start -->\n## Findings\n"
                  "<!-- analyze-sentry-issue-findings:end -->")

# Stands in for the GitHub CLI: logs each call with its standard input, lists
# the fixture's issues and one issue's comments as slurped GraphQL pages, each
# field only when the query asks for it, and files issues, labels, and
# comments as the Actions bot.
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
base = Path(os.environ["FIXTURE"])
args = sys.argv[1:]
stdin = "" if sys.stdin.isatty() else sys.stdin.read()
with (base / "gh-calls").open("a") as log:
    log.write(json.dumps({"args": args, "stdin": stdin}) + "\n")
issues = json.loads((base / "issues.json").read_text())
bot = {"__typename": "Bot", "login": "github-actions"}

def value(prefix):
    return next(arg[len(prefix):] for arg in args if arg.startswith(prefix))

def option(name):
    return args[args.index(name) + 1]

def find(number):
    return next(issue for issue in issues if issue["number"] == int(number))

def save():
    (base / "issues.json").write_text(json.dumps(issues))

if args[:2] == ["api", "graphql"]:
    query = value("query=")
    if "comments(" in query:
        comments = find(value("number="))["comments"]
        print(json.dumps([{"data": {"repository": {"issue": {"comments": {"nodes": comments}}}}}]))
        sys.exit()
    listed = []
    for issue in issues:
        node = {"number": issue["number"], "title": issue["title"], "state": issue["state"],
                "stateReason": None, "body": issue["body"]}
        if "author { __typename login }" in query:
            node["author"] = issue["author"]
        if "labels(" in query:
            node["labels"] = {"nodes": [{"name": name} for name in issue["labels"]]}
        listed.append(node)
    pages = [listed[start:start + 100] for start in range(0, max(len(listed), 1), 100)]
    print(json.dumps([{"data": {"repository": {"issues": {"nodes": page}}}} for page in pages]))
elif args[:2] == ["issue", "create"]:
    if (base / "fail-create").exists():
        sys.exit(1)
    number = max([issue["number"] for issue in issues] + [300]) + 1
    labels = [args[index + 1] for index, arg in enumerate(args) if arg == "--label"]
    issues.append({"number": number, "title": option("--title"), "state": "OPEN", "body": stdin,
                   "author": bot, "labels": labels, "comments": []})
    save()
    print(f"https://github.com/jubishop/screenr/issues/{number}")
elif args[:2] == ["issue", "edit"]:
    find(args[2])["labels"].append(option("--add-label"))
    save()
elif args[:2] == ["issue", "comment"]:
    if (base / "fail-comment").exists():
        sys.exit(1)
    find(args[2])["comments"].append({"body": stdin, "author": bot})
    save()
else:
    sys.exit(2)
'''


def issue(number, body, author=ACTIONS_BOT, state="OPEN", labels=(), comments=()):
    """Return a GitHub issue as the fake gh stores it."""
    return {"number": number, "title": f"Issue {number}", "state": state, "body": body, "author": author,
            "labels": list(labels), "comments": list(comments)}


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


def error(issue_id, short_id, project="screenr-ios"):
    """Return a Sentry error issue as the issues API lists it, with an error that quotes member data."""
    return {
        "id": issue_id, "shortId": short_id, "firstSeen": "2026-11-08T17:30:00Z",
        "lastSeen": "2026-11-09T17:30:00Z", "title": f"Error: {ERROR_TEXT}",
        "culprit": "TitleReviewView.load", "level": "error", "status": "unresolved",
        "issueCategory": "error", "count": "3", "userCount": 2,
        "permalink": f"https://artisanal-software.sentry.io/issues/{issue_id}/",
        "metadata": {"type": "Error", "value": ERROR_TEXT}, "project": {"slug": project},
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


def feedback_link(issue_id):
    return (f"https://artisanal-software.sentry.io/feedback/"
            f"?feedbackSlug=screenr-ios%3A{issue_id}&project={IOS}")


def instructions(kind, argument, link_text, link):
    """Return the instruction comment that makes an item's analysis a fix-issue prerequisite."""
    marker, skill, command, details = {
        "feedback": ("sfeedback", "analyze-sentry-feedback", "bin/snfeedback", "Protected feedback details"),
        "issue": ("snissue", "analyze-sentry-issue", "bin/snissue", "Event details"),
    }[kind]
    return (f"<!-- {marker}:{argument} -->\n"
            f"<!-- fix-issue-prerequisite: {skill} {argument} -->\n"
            "This issue is intake only and must be analyzed before implementation.\n"
            "\n"
            f"- Run `{command} {argument}` from a Screenr checkout to analyze it directly.\n"
            "- If passed to `fix-issue`, it will run the same analysis prerequisite, refresh this issue, "
            "and then continue from the findings.\n"
            "\n"
            f"{details} remain in Sentry: [{link_text}]({link}).\n")


def error_instructions(issue_id, short_id):
    return instructions("issue", issue_id, short_id, f"https://artisanal-software.sentry.io/issues/{issue_id}/")


def feedback_instructions(issue_id):
    return instructions("feedback", f"screenr-ios:{issue_id}", f"screenr-ios:{issue_id}", feedback_link(issue_id))


class FakeSentry(BaseHTTPRequestHandler):
    """Serve canned Sentry API responses keyed by path, project, query, and cursor."""

    def do_GET(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        self.server.requests.append({"path": url.path, "query": query,
                                     "authorization": self.headers.get("Authorization")})
        key = (url.path, query.get("project", [None])[0], query.get("query", [None])[0],
               query.get("cursor", [None])[0])
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


class SentryIntakeTests(unittest.TestCase):
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
        # Nothing is unresolved unless a test says so.
        self.feedback_pages([])
        self.error_pages(IOS, [])
        self.error_pages(SERVER, [])

        environment = {key: value for key, value in os.environ.items()
                       if key not in {"GITHUB_STEP_SUMMARY", "GH_REPO"}}
        self.environment = {**environment, "FIXTURE": str(self.fixture),
                            "PATH": str(commands) + os.pathsep + os.environ["PATH"],
                            "SENTRY_API_URL": self.base + "/api/0",
                            "SENTRY_AUTH_TOKEN": "sentry-test-token", "no_proxy": "*"}

    def issues(self, issues):
        (self.fixture / "issues.json").write_text(json.dumps(issues))

    def filed_issues(self):
        return {filed["number"]: filed for filed in json.loads((self.fixture / "issues.json").read_text())}

    def pages(self, project, query, pages):
        """Serve one project's issue list for a query as pages linked by Sentry cursors."""
        path = f"{API}/issues/"
        for index, page in enumerate(pages):
            cursor = None if index == 0 else f"0:{index * 100}:0"
            following = f"0:{(index + 1) * 100}:0"
            more = "true" if index + 1 < len(pages) else "false"
            parameters = urlencode({"project": project, "query": query, "cursor": following})
            link = (f'<{self.base}{path}?cursor=0:0:1>; rel="previous"; results="false"; '
                    f'cursor="0:0:1", <{self.base}{path}?{parameters}>; '
                    f'rel="next"; results="{more}"; cursor="{following}"')
            self.sentry.responses[(path, project, query, cursor)] = (200, page, link)

    def feedback_pages(self, *pages):
        self.pages(IOS, FEEDBACK_QUERY, pages)

    def error_pages(self, project, *pages):
        self.pages(project, ERROR_QUERY, pages)

    def latest_event(self, issue_id, body, status=200):
        self.sentry.responses[(f"{API}/issues/{issue_id}/events/latest/", None, None, None)] = (status, body, None)

    def gh_calls(self):
        path = self.fixture / "gh-calls"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def created(self):
        return [call for call in self.gh_calls() if call["args"][:2] == ["issue", "create"]]

    def titles(self):
        return [call["args"][call["args"].index("--title") + 1] for call in self.created()]

    def writes(self):
        """Return each GitHub write: the created titles, the labels added, and the issues commented on."""
        writes = []
        for call in self.gh_calls():
            args = call["args"]
            if args[:2] == ["issue", "create"]:
                writes.append(("create", args[args.index("--title") + 1]))
            elif args[:2] == ["issue", "edit"]:
                writes.append(("label", int(args[2]), args[args.index("--add-label") + 1]))
            elif args[:2] == ["issue", "comment"]:
                writes.append(("comment", int(args[2])))
            elif args[:2] != ["api", "graphql"]:
                writes.append(("other", args))
        return writes

    def run_command(self, *args, status=0, environment=None):
        result = subprocess.run(
            [sys.executable, str(ROOT / "bin/sentry-intake"), *args],
            env=environment or self.environment, stdin=subprocess.DEVNULL, capture_output=True,
            text=True, timeout=HANG_SECONDS,
        )
        self.assertEqual(result.returncode, status, result.stderr)
        return result

    def assert_no_member_content(self, result):
        published = json.dumps(self.gh_calls()) + result.stdout + result.stderr
        for private in PRIVATE:
            self.assertNotIn(private, published)

    def test_files_one_labeled_feedback_issue_with_only_the_link_date_and_build(self):
        self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1", "2026-10-14T03:00:00Z")])
        self.latest_event("7768802020", event())

        result = self.run_command()

        [call] = self.created()
        args = call["args"]
        self.assertEqual(args[args.index("--repo") + 1], "jubishop/screenr")
        self.assertEqual(args[args.index("--title") + 1], "Triage Sentry feedback SCREENR-IOS-1")
        self.assertEqual(args[args.index("--body-file") + 1], "-")
        self.assertEqual([args[index + 1] for index, arg in enumerate(args) if arg == "--label"],
                         ["investigation", "area: ios", "sentry-feedback", "p2"])
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
        self.assertEqual(self.filed_issues()[301]["comments"],
                         [{"body": feedback_instructions("7768802020"), "author": ACTIONS_BOT}])
        self.assertIn("issues/301", result.stdout)
        self.assert_no_member_content(result)

    def test_files_one_labeled_error_issue_per_unresolved_error_in_each_project(self):
        self.error_pages(IOS, [error("7838092494", "SCREENR-IOS-3"), error("7830956786", "SCREENR-IOS-2")])
        self.error_pages(SERVER, [error("7791030616", "SCREENR-SERVER-2", "screenr-server")])
        summary = self.fixture / "summary.md"

        result = self.run_command(environment={**self.environment, "GITHUB_STEP_SUMMARY": str(summary)})

        # Oldest first, across both projects.
        self.assertEqual(self.titles(), ["Triage Sentry issue SCREENR-SERVER-2", "Triage Sentry issue SCREENR-IOS-2",
                                         "Triage Sentry issue SCREENR-IOS-3"])
        labels = [[call["args"][index + 1] for index, arg in enumerate(call["args"]) if arg == "--label"]
                  for call in self.created()]
        self.assertEqual(labels, [["investigation", "area: server", "sentry-issue", "p2"],
                                  ["investigation", "area: ios", "sentry-issue", "p2"],
                                  ["investigation", "area: ios", "sentry-issue", "p2"]])
        self.assertEqual(self.created()[0]["stdin"], (
            "<!-- sentry-issue:7791030616 -->\n"
            "An unresolved Sentry issue needs triage.\n"
            "\n"
            "- **Sentry issue:** [SCREENR-SERVER-2](https://artisanal-software.sentry.io/issues/7791030616/)\n"
            "\n"
            "Event details remain in Sentry because this repository is public.\n"
        ))
        filed = self.filed_issues()
        self.assertEqual([comment["body"] for comment in filed[301]["comments"]],
                         [error_instructions("7791030616", "SCREENR-SERVER-2")])
        self.assertEqual([comment["body"] for comment in filed[302]["comments"]],
                         [error_instructions("7830956786", "SCREENR-IOS-2")])
        self.assertEqual(len(filed[303]["comments"]), 1)
        # No event is read for an error: the issue copies nothing from one.
        self.assertFalse([request for request in self.sentry.requests if "/events/" in request["path"]])
        self.assert_no_member_content(result)
        self.assertEqual(summary.read_text(), (
            "## Sentry intake\n\n"
            "Found 0 unresolved feedback item(s) and 3 unresolved error issue(s); 0 already tracked.\n"
            "Filed 0 feedback issue(s), 3 error issue(s), and 0 recurrence issue(s); "
            "added 0 label(s) and 3 instruction comment(s).\n"))

    def test_rerun_files_no_issue_and_adds_no_comment(self):
        self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1")])
        self.latest_event("7768802020", event())
        self.error_pages(IOS, [error("7830956786", "SCREENR-IOS-2")])

        self.run_command()
        first = self.writes()
        result = self.run_command()

        self.assertEqual(self.writes(), first)
        self.assertEqual(len(self.created()), 2)
        self.assertIn("Already tracked: SCREENR-IOS-1 in #301", result.stdout)
        self.assertIn("Already tracked: SCREENR-IOS-2 in #302", result.stdout)
        self.assertIn("Filed 0 feedback issue(s), 0 error issue(s), and 0 recurrence issue(s); "
                      "added 0 label(s) and 0 instruction comment(s).", result.stdout)

    def test_an_error_whose_tracking_issues_all_closed_gets_a_recurrence_issue(self):
        link = "https://artisanal-software.sentry.io/issues/123/"
        self.issues([
            issue(20, "<!-- sentry-issue:123 -->\nIntake.", state="CLOSED", labels=["sentry-issue"]),
            issue(25, f"Fixed the hang in {link}.\n" + ERROR_FINDINGS, author=OWNER, state="CLOSED"),
            # Neither a stranger's open issue nor another error's closed one tracks it.
            issue(30, "<!-- sentry-issue:123 -->", author=STRANGER),
            issue(31, "<!-- sentry-issue:1234 -->", state="CLOSED"),
        ])
        self.error_pages(IOS, [error("123", "SCREENR-IOS-7")])

        result = self.run_command()

        self.assertEqual(self.titles(), ["Triage recurrence of Sentry issue SCREENR-IOS-7"])
        self.assertEqual(self.created()[0]["stdin"], (
            "<!-- sentry-issue:123 -->\n"
            "An unresolved Sentry issue needs triage again after its tracking issues closed.\n"
            "\n"
            f"- **Sentry issue:** [SCREENR-IOS-7]({link})\n"
            "- **Earlier tracking issues:** #20, #25\n"
            "\n"
            "Event details remain in Sentry because this repository is public.\n"
        ))
        # The closed issues are never reopened, relabeled, or commented on.
        self.assertEqual(self.writes(), [("create", "Triage recurrence of Sentry issue SCREENR-IOS-7"),
                                         ("comment", 301)])
        self.assertIn("filed 0 feedback issue(s), 0 error issue(s), and 1 recurrence issue(s)",
                      result.stdout.lower())

        # The recurrence issue now tracks it, so a rerun files nothing.
        self.run_command()
        self.assertEqual(len(self.created()), 1)

    def test_feedback_never_recurs_and_its_closed_issue_only_gains_the_label(self):
        self.issues([issue(40, "<!-- sentry-feedback:screenr-ios:7768802020 -->\nClosed.", state="CLOSED",
                           labels=["investigation", "area: ios"])])
        self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1")])

        result = self.run_command()

        self.assertEqual(self.writes(), [("label", 40, "sentry-feedback")])
        self.assertIn("Already tracked: SCREENR-IOS-1 in #40", result.stdout)

    def test_open_tracking_issues_gain_a_missing_label_and_one_instruction_comment_until_analyzed(self):
        marker = "<!-- sentry-issue:{} -->"
        self.issues([
            # An analysis issue that predates the label keeps its priority and gains the label.
            issue(50, marker.format(501), author=OWNER, labels=["improvement", "area: ios", "p3"]),
            # A complete findings block, or a closeout from before the marker, needs no instructions.
            issue(51, marker.format(511) + "\n" + ERROR_FINDINGS, labels=["sentry-issue"]),
            issue(52, "https://artisanal-software.sentry.io/issues/521/\n## Sentry closeout\n", author=OWNER,
                  labels=["sentry-issue"]),
            # Instructions already left by the bot count; a stranger's copy does not.
            issue(53, marker.format(531), labels=["sentry-issue"],
                  comments=[{"body": error_instructions("531", "SCREENR-IOS-53"), "author": ACTIONS_BOT}]),
            issue(54, marker.format(541), labels=["sentry-issue"],
                  comments=[{"body": error_instructions("541", "SCREENR-IOS-54"), "author": STRANGER}]),
            # Half a findings block is no analysis.
            issue(55, marker.format(551) + "\n<!-- analyze-sentry-issue-findings:start -->", labels=["sentry-issue"]),
            # An open issue is canonical over a closed one; among open ones, the marker over a link.
            issue(56, marker.format(561), state="CLOSED"),
            issue(57, "https://artisanal-software.sentry.io/issues/561/", author=OWNER),
            issue(58, marker.format(561), labels=["sentry-issue"]),
            # A feedback issue gains its own label and instructions.
            issue(59, "<!-- sentry-feedback:screenr-ios:591 -->", labels=["investigation", "area: ios"]),
        ])
        self.feedback_pages([feedback("591", "SCREENR-IOS-59")])
        self.error_pages(IOS, [error(issue_id, f"SCREENR-IOS-{issue_id[:2]}")
                               for issue_id in ("501", "511", "521", "531", "541", "551", "561")])

        result = self.run_command()

        self.assertEqual(self.writes(), [
            ("label", 59, "sentry-feedback"), ("comment", 59),
            ("label", 50, "sentry-issue"), ("comment", 50),
            ("comment", 54),
            ("comment", 55),
            ("comment", 58),
        ])
        filed = self.filed_issues()
        self.assertEqual(filed[50]["labels"], ["improvement", "area: ios", "p3", "sentry-issue"])
        self.assertEqual(filed[59]["comments"][-1]["body"], feedback_instructions("591"))
        self.assertEqual(filed[58]["comments"][-1]["body"], error_instructions("561", "SCREENR-IOS-56"))
        # Comments are read only for open issues that still need instructions.
        read = [int(next(arg for arg in call["args"] if arg.startswith("number="))[len("number="):])
                for call in self.gh_calls() if call["args"][:2] == ["api", "graphql"]
                and any(arg.startswith("number=") for arg in call["args"])]
        self.assertEqual(read, [59, 50, 53, 54, 55, 58])
        self.assertIn("Found 1 unresolved feedback item(s) and 7 unresolved error issue(s); 8 already tracked.",
                      result.stdout)

    def test_skips_feedback_filed_in_open_or_closed_issues_without_reading_it(self):
        self.issues([
            issue(12, None, author=OWNER),
            issue(40, "<!-- sentry-feedback:screenr-ios:7768802020 -->\nClosed.", state="CLOSED",
                  labels=["sentry-feedback"]),
            # A maintainer removed the marker but kept the link.
            issue(41, f"- **Feedback:** [SCREENR-IOS-2]({feedback_link('7768800421')})\n" + FEEDBACK_FINDINGS,
                  labels=["sentry-feedback"]),
            # Another feedback ID that merely starts with a pending one.
            issue(42, "<!-- sentry-feedback:screenr-ios:77688 -->"),
        ])
        self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1"),
                             feedback("7768800421", "SCREENR-IOS-2"),
                             feedback("776880", "SCREENR-IOS-3")])
        self.latest_event("776880", event())

        result = self.run_command()

        [call] = self.created()
        self.assertIn("screenr-ios:776880 -->", call["stdin"])
        self.assertIn("Already tracked: SCREENR-IOS-1 in #40", result.stdout)
        self.assertIn("Already tracked: SCREENR-IOS-2 in #41", result.stdout)
        fetched = [request["path"] for request in self.sentry.requests if "/events/" in request["path"]]
        self.assertEqual(fetched, [f"{API}/issues/776880/events/latest/"])
        # One batched listing of every issue, whatever the item count.
        self.assertEqual([call["args"][:4] for call in self.gh_calls()
                          if call["args"][0] == "api" and not any(arg.startswith("number=") for arg in call["args"])],
                         [["api", "graphql", "--paginate", "--slurp"]])

    def test_only_issues_from_the_filing_account_or_the_owner_count_as_filed(self):
        # The repository is public, so anyone can open an issue with a marker or link.
        self.issues([
            issue(50, "<!-- sentry-feedback:screenr-ios:100 -->", author=STRANGER),
            issue(51, f"- [SCREENR-IOS-2]({feedback_link(200)})", author=STRANGER),
            # Neither a user who takes the bot's name nor a deleted account counts.
            issue(52, "<!-- sentry-feedback:screenr-ios:300 -->", author={"__typename": "User",
                                                                          "login": "github-actions"}),
            issue(53, "<!-- sentry-feedback:screenr-ios:400 -->", author=None),
            issue(54, "<!-- sentry-feedback:screenr-ios:500 -->", labels=["sentry-feedback"],
                  comments=[{"body": feedback_instructions("500"), "author": ACTIONS_BOT}]),
            issue(55, f"Moved from #54: {feedback_link(600)}", author=OWNER, labels=["sentry-feedback"],
                  comments=[{"body": feedback_instructions("600"), "author": OWNER}]),
            issue(56, "<!-- sentry-issue:700 -->", author=STRANGER, state="CLOSED"),
        ])
        self.feedback_pages([feedback(issue_id, f"SCREENR-IOS-{issue_id}")
                             for issue_id in ("100", "200", "300", "400", "500", "600")])
        self.error_pages(IOS, [error("700", "SCREENR-IOS-700")])
        for issue_id in ("100", "200", "300", "400"):
            self.latest_event(issue_id, event())

        result = self.run_command()

        # A stranger's closed issue is no earlier tracking issue, so the error is new, not a recurrence.
        self.assertEqual(self.titles(), [f"Triage Sentry feedback SCREENR-IOS-{issue_id}"
                                         for issue_id in ("100", "200", "300", "400")]
                         + ["Triage Sentry issue SCREENR-IOS-700"])
        self.assertIn("Already tracked: SCREENR-IOS-500 in #54", result.stdout)
        self.assertIn("Already tracked: SCREENR-IOS-600 in #55", result.stdout)

    def test_reads_every_page_of_each_list_and_files_oldest_first(self):
        self.feedback_pages([feedback("900", "SCREENR-IOS-9")], [feedback("100", "SCREENR-IOS-4")])
        self.error_pages(SERVER, [error("950", "SCREENR-SERVER-9", "screenr-server")],
                         [error("150", "SCREENR-SERVER-4", "screenr-server")])
        self.latest_event("900", event())
        self.latest_event("100", event())

        self.run_command()

        self.assertEqual(self.titles(), ["Triage Sentry feedback SCREENR-IOS-4", "Triage Sentry feedback SCREENR-IOS-9",
                                         "Triage Sentry issue SCREENR-SERVER-4", "Triage Sentry issue SCREENR-SERVER-9"])
        listings = [(request["query"]["project"], request["query"]["query"])
                    for request in self.sentry.requests if request["path"] == f"{API}/issues/"]
        self.assertEqual(sorted(listings), sorted([
            ([IOS], [FEEDBACK_QUERY]), ([IOS], [FEEDBACK_QUERY]), ([IOS], [ERROR_QUERY]),
            ([SERVER], [ERROR_QUERY]), ([SERVER], [ERROR_QUERY])]))
        for request in self.sentry.requests:
            self.assertEqual(request["authorization"], "Bearer sentry-test-token")

    def test_a_partial_list_files_nothing(self):
        path = f"{API}/issues/"
        cases = {
            # The second page of the server's errors fails after the first page arrived.
            "failed later page": lambda: self.sentry.responses.__setitem__(
                (path, SERVER, ERROR_QUERY, "0:100:0"), (500, {"detail": ERROR_TEXT}, None)),
            # One project's list fails while the other lists are complete.
            "failed project": lambda: self.sentry.responses.__setitem__(
                (path, SERVER, ERROR_QUERY, None), (503, {"detail": ERROR_TEXT}, None)),
        }
        for name, fail in cases.items():
            with self.subTest(name):
                self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1")])
                self.latest_event("7768802020", event())
                self.error_pages(IOS, [error("7830956786", "SCREENR-IOS-2")])
                self.error_pages(SERVER, [error("950", "SCREENR-SERVER-9", "screenr-server")],
                                 [error("150", "SCREENR-SERVER-4", "screenr-server")])
                fail()

                result = self.run_command(status=1)

                self.assertRegex(result.stderr, "HTTP 50[03]")
                self.assertEqual(self.gh_calls(), [])
                self.assert_no_member_content(result)

    def test_a_failed_instruction_comment_is_added_on_the_next_run(self):
        self.error_pages(IOS, [error("7830956786", "SCREENR-IOS-2")])
        (self.fixture / "fail-comment").touch()

        self.run_command(status=1)
        (self.fixture / "fail-comment").unlink()
        result = self.run_command()

        self.assertEqual(len(self.created()), 1)
        self.assertEqual([comment["body"] for comment in self.filed_issues()[301]["comments"]],
                         [error_instructions("7830956786", "SCREENR-IOS-2")])
        self.assertIn("Already tracked: SCREENR-IOS-2 in #301", result.stdout)

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

    def test_nothing_unresolved_reads_no_github_issues(self):
        result = self.run_command()

        self.assertEqual(self.gh_calls(), [])
        self.assertIn("Found 0 unresolved feedback item(s) and 0 unresolved error issue(s)", result.stdout)

    def test_dry_run_writes_nothing(self):
        self.issues([issue(60, "<!-- sentry-issue:600 -->", author=OWNER)])
        self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1")])
        self.latest_event("7768802020", event())
        self.error_pages(IOS, [error("600", "SCREENR-IOS-6")])
        self.error_pages(SERVER, [error("700", "SCREENR-SERVER-7", "screenr-server")])

        result = self.run_command("--dry-run")

        self.assertEqual(self.writes(), [])
        self.assertEqual(result.stdout, (
            "Would file: Triage Sentry feedback SCREENR-IOS-1\n"
            "Would add the instruction comment to the new issue for SCREENR-IOS-1\n"
            "Would add the sentry-issue label to #60\n"
            "Would add the instruction comment to #60\n"
            "Already tracked: SCREENR-IOS-6 in #60\n"
            "Would file: Triage Sentry issue SCREENR-SERVER-7\n"
            "Would add the instruction comment to the new issue for SCREENR-SERVER-7\n"
            "Found 1 unresolved feedback item(s) and 2 unresolved error issue(s); 1 already tracked.\n"
            "Would file 1 feedback issue(s), 1 error issue(s), and 0 recurrence issue(s); "
            "would add 1 label(s) and 3 instruction comment(s).\n"
        ))

    def test_unexpected_sentry_responses_file_nothing(self):
        cases = {
            "non-numeric ID": ([feedback("77x", "SCREENR-IOS-1")], []),
            "member text as short ID": ([feedback("7768802020", MEMBER_TEXT)], []),
            "timestamp without zone": ([feedback("7768802020", "SCREENR-IOS-1", "2026-10-13T17:30:00")], []),
            "object instead of list": ({"detail": MEMBER_TEXT}, []),
            "error text as short ID": ([], [error("7830956786", ERROR_TEXT)]),
            "error without an ID": ([], [{"shortId": "SCREENR-IOS-2", "title": ERROR_TEXT}]),
            "error object instead of list": ([], {"detail": ERROR_TEXT}),
        }
        for name, (feedback_page, error_page) in cases.items():
            with self.subTest(name):
                self.feedback_pages(feedback_page)
                self.error_pages(IOS, error_page)
                self.latest_event("7768802020", event())
                result = self.run_command(status=1)
                self.assertIn("unexpected", result.stderr)
                self.assertEqual(self.gh_calls(), [])
                self.assert_no_member_content(result)

    def test_sentry_and_github_failures_exit_with_an_error(self):
        self.sentry.responses[(f"{API}/issues/", IOS, FEEDBACK_QUERY, None)] = (401, {"detail": MEMBER_TEXT}, None)
        result = self.run_command(status=1)
        self.assertIn("HTTP 401", result.stderr)
        self.assertEqual(self.gh_calls(), [])
        self.assert_no_member_content(result)

        self.feedback_pages([feedback("7768802020", "SCREENR-IOS-1")])
        self.latest_event("7768802020", event())
        (self.fixture / "fail-create").touch()
        self.run_command(status=1)
        self.assertEqual(self.filed_issues(), {})

    def test_next_page_on_another_host_is_refused(self):
        link = '<https://attacker.example/api/0/issues/?cursor=1>; rel="next"; results="true"'
        self.sentry.responses[(f"{API}/issues/", SERVER, ERROR_QUERY, None)] = (200, [], link)
        result = self.run_command(status=1)
        self.assertIn("unexpected", result.stderr)
        self.assertEqual(self.gh_calls(), [])

    def test_requires_a_sentry_token(self):
        environment = {**self.environment, "SENTRY_AUTH_TOKEN": ""}
        result = self.run_command(status=1, environment=environment)
        self.assertIn("SENTRY_AUTH_TOKEN", result.stderr)
        self.assertEqual(self.sentry.requests, [])


if __name__ == "__main__":
    unittest.main()
