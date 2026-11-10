"""Verify the Sentry analysis skills' helpers against fake sentry, gh, and ssh commands and synthetic log tails."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from _process_waits import HANG_SECONDS

ROOT = Path(__file__).resolve().parents[1]
HELPERS = ROOT / ".agents/scripts/sentry-cli"

FAKE_SENTRY = r'''
import json
import os
import sys

args = sys.argv[1:]
with open(os.environ["FAKE_CALL_LOG"], "a") as stream:
    stream.write(json.dumps(["sentry", *args]) + "\n")

if args[:2] == ["auth", "status"]:
    raise SystemExit(int(os.environ.get("FAKE_SENTRY_AUTH_EXIT", "0")))

if args[:2] == ["issue", "view"]:
    project = os.environ.get("FAKE_SENTRY_PROJECT", "screenr-ios")
    print(json.dumps({
        "id": "123",
        "shortId": "SCREENR-IOS-ABC",
        "title": "Example failure",
        "status": "unresolved",
        "level": "error",
        "count": "3",
        "userCount": 2,
        "firstSeen": "2025-01-02T03:04:05Z",
        "lastSeen": "2025-01-03T03:04:05Z",
        "org": os.environ.get("FAKE_SENTRY_ORG", "artisanal-software"),
        "project": {"slug": project},
    }))
    raise SystemExit(0)

if args[:2] == ["issue", "events"]:
    if os.environ.get("FAKE_SENTRY_EMPTY_EVENTS") == "1":
        print('{"data": []}')
    else:
        print(json.dumps({"data": [{
            "id": os.environ.get("FAKE_SENTRY_EVENT_ID", "event-1"),
            "dateCreated": "2025-01-03T03:04:05Z",
            "title": "Example failure",
            "entries": [{"type": "exception", "data": {"values": [{"type": "ExampleError", "value": "failed"}]}}],
            "tags": [{"key": "release", "value": "example-release"}, {"key": "request_id", "value": "request-1"}],
        }]}))
    raise SystemExit(0)

if args and args[0] == "api":
    endpoint = args[1]
    if "/attachments/attachment-1/" in endpoint:
        sys.stdout.buffer.write(bytes.fromhex(os.environ["FAKE_SENTRY_RAW_HEX"]))
        raise SystemExit(0)
    if "/attachments/attachment-2/" in endpoint:
        print("escape")
        raise SystemExit(0)
    if endpoint.endswith("/attachments/"):
        body = [
            {"id": "attachment-1", "name": "app.ndjson", "size": 4},
            {"id": "attachment-2", "name": "../../escape.txt", "size": 6},
        ]
    elif "/tags/user/" in endpoint:
        body = [{"value": None, "count": 3}]
    elif "/tags/" in endpoint:
        body = [{"value": "example", "count": 3}]
    elif "/events/?" in endpoint:
        body = [{"id": os.environ.get("FAKE_SENTRY_EVENT_ID", "event-1"),
                 "tags": [{"key": "release", "value": "example-release"}],
                 "contexts": {"feedback": {"message": "Example feedback"}}}]
    elif endpoint.endswith("/activities/"):
        body = {"activity": [{"id": "activity-1", "type": "set_unresolved"}]}
    elif endpoint.endswith("/notes/"):
        body = [{"id": "note-1", "text": "Example note"}]
    else:
        raise SystemExit(f"unsupported fake API endpoint: {endpoint}")
    response = {"status": 200, "statusText": "OK", "body": body}
    if os.environ.get("FAKE_SENTRY_API_MATCH", "unlikely") in endpoint:
        mode = os.environ.get("FAKE_SENTRY_API_MODE")
        if mode == "empty":
            response["body"] = {"activity": []} if "/activities/" in endpoint else []
        elif mode == "http":
            response = {"status": 403, "statusText": "Forbidden", "body": {"detail": "denied"}}
        elif mode == "json":
            print("not json")
            raise SystemExit(0)
        elif mode == "type":
            response["body"] = "unexpected"
        elif mode == "row":
            response["body"] = ["unexpected"]
        elif mode == "fields":
            response["body"] = [{}]
        elif mode == "bare":
            response = body
        elif mode == "status":
            response["status"] = "200"
        elif mode == "missing_body":
            del response["body"]
        elif mode == "exit":
            print("synthetic CLI failure", file=sys.stderr)
            print(json.dumps(response))
            raise SystemExit(1)
    print(json.dumps(response))
    raise SystemExit(0)

if args and args[0] == "explore":
    print(json.dumps({"data": [{"project": "screenr-server", "issue": "SCREENR-SERVER-ABC",
                                "title": "Example failure", "timestamp": "2025-01-03T03:04:05Z",
                                "request_id": "request-1", "user.id": "user-1"}]}))
    raise SystemExit(0)

print(f"unsupported fake sentry command: {args}", file=sys.stderr)
raise SystemExit(2)
'''

# Records its arguments, then prints FAKE_GH_OUTPUT and exits with FAKE_GH_EXIT.
FAKE_GH = r'''
import json
import os
import sys

with open(os.environ["FAKE_CALL_LOG"], "a") as stream:
    stream.write(json.dumps(["gh", *sys.argv[1:]]) + "\n")
print(os.environ.get("FAKE_GH_OUTPUT", "[]"))
if os.environ.get("FAKE_GH_EXIT", "0") != "0":
    print("synthetic gh failure", file=sys.stderr)
raise SystemExit(int(os.environ.get("FAKE_GH_EXIT", "0")))
'''

# Records its arguments, then prints FAKE_SSH_OUTPUT and exits with FAKE_SSH_EXIT.
FAKE_SSH = r'''
import json
import os
import sys

with open(os.environ["FAKE_CALL_LOG"], "a") as stream:
    stream.write(json.dumps(["ssh", *sys.argv[1:]]) + "\n")
sys.stdout.write(os.environ.get("FAKE_SSH_OUTPUT", ""))
if os.environ.get("FAKE_SSH_EXIT", "0") != "0":
    print("Permission denied (publickey).", file=sys.stderr)
raise SystemExit(int(os.environ.get("FAKE_SSH_EXIT", "0")))
'''

ACTIONS_BOT = {"__typename": "Bot", "login": "github-actions"}
OWNER = {"__typename": "User", "login": "jubishop"}
STRANGER = {"__typename": "User", "login": "stranger"}
FINDINGS = ("<!-- analyze-sentry-issue-findings:start -->\n## Findings\n"
            "<!-- analyze-sentry-issue-findings:end -->\n")
JOURNAL = (
    "2026-11-08T19:59:59.000001+00:00 host node[1]: Ready in 120ms\n"
    "--- window ---\n"
    '2026-11-08T20:14:40.000001+00:00 host node[1]: {"event":"request failed","action":"screen",'
    '"status":500,"requestId":"request-1","error":"DatabaseError","code":"57P01"}\n'
    '2026-11-08T20:14:41.000001+00:00 host node[1]: ⨯ {"error":"DatabaseError","code":"57P01"}\n'
    '2026-11-08T20:14:42.000001+00:00 host node[1]: {"event":"request failed","action":"notifications",'
    '"status":500,"requestId":"request-2","error":"DatabaseError","code":"57P01"}\n'
    '2026-11-08T20:14:43.000001+00:00 host node[2]: {"event":"worker failed","failures":1}\n'
    "2026-11-08T20:14:44.000001+00:00 host node[2]: Started screenr-worker.service\n"
)


class SentryHelperTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="screenr sentry helpers ")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.call_log = self.root / "calls.jsonl"
        self.tools = self.root / "tools"
        self.tools.mkdir()
        for name, body in (("sentry", FAKE_SENTRY), ("gh", FAKE_GH), ("ssh", FAKE_SSH)):
            path = self.tools / name
            path.write_text("#!" + sys.executable + "\n" + body)
            path.chmod(0o755)

    def run_helper(self, name: str, *arguments: str,
                   extra_environment: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        environment = {key: value for key, value in os.environ.items() if not key.startswith("FAKE_")}
        environment.update(
            PATH=f"{self.tools}{os.pathsep}{environment.get('PATH', '')}",
            SENTRY_BIN=str(self.tools / "sentry"),
            FAKE_CALL_LOG=str(self.call_log),
            FAKE_SENTRY_RAW_HEX=b' {"message":"one"}\r\n{"message":"two"}\n'.hex(),
        )
        environment.pop("GH_REPO", None)
        environment.update(extra_environment or {})
        command = ["bash"] if name.endswith(".sh") else [sys.executable, "-I"]
        return subprocess.run([*command, str(HELPERS / name), *arguments], cwd=ROOT, env=environment,
                              capture_output=True, text=True, check=False, timeout=HANG_SECONDS)

    def calls(self, tool: str | None = None) -> list[list[str]]:
        if not self.call_log.exists():
            return []
        calls = [json.loads(line) for line in self.call_log.read_text().splitlines()]
        return [call[1:] for call in calls if tool is None or call[0] == tool]

    def write_issue_json(self, project: str = "screenr-ios") -> Path:
        path = self.root / "issue.json"
        path.write_text(json.dumps({"org": "artisanal-software", "project": {"slug": project}}))
        return path


class IssueBundleTests(SentryHelperTests):
    def test_issue_fetch_uses_recorded_lifetime_and_writes_an_event(self) -> None:
        output = self.root / "issue-output"

        result = self.run_helper("fetch_issue_bundle.sh", "SCREENR-IOS-ABC", "--out", str(output),
                                 "--events", "2")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((output / "event_event-1.json").is_file())
        self.assertIn("environment: example (3)", result.stdout)
        self.assertIn("ExampleError: failed  release=example-release  request_id=request-1", result.stdout)
        self.assertEqual(json.loads((output / "tags_environment.json").read_text()),
                         [{"value": "example", "count": 3}])
        event_call = next(call for call in self.calls("sentry") if call[:2] == ["issue", "events"])
        self.assertEqual(event_call[event_call.index("--period") + 1], ">=2025-01-02T03:04:05Z")

    def test_issue_url_resolves_to_its_numeric_id(self) -> None:
        result = self.run_helper("fetch_issue_bundle.sh", "https://artisanal-software.sentry.io/issues/123/?project=1",
                                 "--out", str(self.root / "issue-output"))

        self.assertEqual(result.returncode, 0, result.stderr)
        view = next(call for call in self.calls("sentry") if call[:2] == ["issue", "view"])
        self.assertEqual(view[2], "123")

    def test_app_issue_reads_build_and_device_tags_and_shows_unset_users(self) -> None:
        output = self.root / "issue-output"

        result = self.run_helper("fetch_issue_bundle.sh", "123", "--out", str(output))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(path.name for path in output.glob("tags_*.json")),
                         ["tags_device.json", "tags_environment.json", "tags_os.json", "tags_release.json",
                          "tags_user.json"])
        self.assertEqual(json.loads((output / "tags_user.json").read_text()), [{"value": None, "count": 3}])
        self.assertIn("user: (not set) (3)", result.stdout)
        self.assertNotIn("unavailable", result.stdout + result.stderr)

    def test_server_issue_reads_event_and_request_tags(self) -> None:
        output = self.root / "issue-output"

        result = self.run_helper("fetch_issue_bundle.sh", "123", "--out", str(output),
                                 extra_environment={"FAKE_SENTRY_PROJECT": "screenr-server"})

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(path.name for path in output.glob("tags_*.json")),
                         ["tags_environment.json", "tags_event.json", "tags_request_id.json"])
        self.assertIn("Project: screenr-server", result.stdout)

    def test_issue_fetch_rejects_an_empty_event_result(self) -> None:
        result = self.run_helper("fetch_issue_bundle.sh", "SCREENR-IOS-ABC", "--out", str(self.root / "issue-output"),
                                 extra_environment={"FAKE_SENTRY_EMPTY_EVENTS": "1"})

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No representative events", result.stderr)

    def test_issue_fetch_rejects_an_issue_outside_screenr(self) -> None:
        for index, environment in enumerate(({"FAKE_SENTRY_PROJECT": "podhaven"}, {"FAKE_SENTRY_ORG": "other"})):
            with self.subTest(environment=environment):
                self.call_log.unlink(missing_ok=True)
                result = self.run_helper("fetch_issue_bundle.sh", "PODHAVEN-ABC",
                                         "--out", str(self.root / f"issue-{index}"), extra_environment=environment)

                self.assertNotEqual(result.returncode, 0)
                self.assertIn("is not a Screenr issue", result.stderr)
                self.assertFalse(any(call[:2] == ["issue", "events"] for call in self.calls("sentry")))

    def test_issue_fetch_rejects_a_nonempty_output_directory(self) -> None:
        output = self.root / "issue-output"
        output.mkdir()
        (output / "stale.json").write_text("{}")

        result = self.run_helper("fetch_issue_bundle.sh", "SCREENR-IOS-ABC", "--out", str(output))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be empty", result.stderr)
        self.assertEqual(self.calls(), [])

    def test_issue_fetch_rejects_an_unsafe_event_id(self) -> None:
        result = self.run_helper("fetch_issue_bundle.sh", "SCREENR-IOS-ABC", "--out", str(self.root / "issue-output"),
                                 extra_environment={"FAKE_SENTRY_EVENT_ID": "../../escape"})

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsafe event ID", result.stderr)
        self.assertFalse((self.root / "escape.json").exists())

    def test_issue_fetch_passes_optional_span_depth(self) -> None:
        result = self.run_helper("fetch_issue_bundle.sh", "SCREENR-IOS-ABC", "--out", str(self.root / "issue-output"),
                                 "--spans", "all")

        self.assertEqual(result.returncode, 0, result.stderr)
        view_call = next(call for call in self.calls("sentry") if call[:2] == ["issue", "view"])
        self.assertEqual(view_call[view_call.index("--spans") + 1], "all")

    def test_authentication_failure_stops_before_requests(self) -> None:
        result = self.run_helper("fetch_issue_bundle.sh", "123", "--out", str(self.root / "issue"),
                                 extra_environment={"FAKE_SENTRY_AUTH_EXIT": "1"})

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("auth required", result.stderr)
        self.assertEqual(self.calls(), [["auth", "status"]])

    def test_missing_cli_stops_without_a_download_fallback(self) -> None:
        environment = {key: value for key, value in os.environ.items() if key != "SENTRY_BIN"}
        environment["PATH"] = "/usr/bin:/bin"
        result = subprocess.run(
            ["bash", str(HELPERS / "fetch_issue_bundle.sh"), "SCREENR-IOS-ABC", "--out", str(self.root / "issue")],
            cwd=ROOT, env=environment, capture_output=True, text=True, check=False, timeout=HANG_SECONDS)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("sentry CLI is required", result.stderr)
        self.assertNotIn("npx", result.stderr)


class FeedbackAndAttachmentTests(SentryHelperTests):
    def test_feedback_fetch_preserves_native_and_fallback_events(self) -> None:
        for fallback in (False, True):
            with self.subTest(fallback=fallback):
                output = self.root / f"feedback-{fallback}"
                result = self.run_helper("fetch_feedback_bundle.sh", "screenr-ios:123", "--out", str(output),
                                         extra_environment={"FAKE_SENTRY_EMPTY_EVENTS": str(int(fallback))})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Feedback screenr-ios:123", result.stdout)
                self.assertIn("Attachments: app.ndjson, ../../escape.txt", result.stdout)
                self.assertIn("Event: event-1", result.stdout)
                event = json.loads((output / "event_event-1.json").read_text())
                self.assertEqual(event["id"], "event-1")
                if fallback:
                    self.assertEqual(event["contexts"]["feedback"]["message"], "Example feedback")
                    self.assertIn("Release: example-release", result.stdout)
                self.assertEqual(json.loads((output / "activities.json").read_text()),
                                 {"activity": [{"id": "activity-1", "type": "set_unresolved"}]})
                self.assertEqual(json.loads((output / "notes.json").read_text()),
                                 [{"id": "note-1", "text": "Example note"}])
        attachment_calls = [call for call in self.calls("sentry") if call[0] == "api" and "/attachments/" in call[1]]
        self.assertTrue(attachment_calls)
        for call in attachment_calls:
            self.assertTrue(call[1].startswith("projects/artisanal-software/screenr-ios/events/event-1/"))

    def test_feedback_reference_forms_resolve_to_the_numeric_id(self) -> None:
        for index, reference in enumerate((
                "123", "screenr-ios:123",
                "https://artisanal-software.sentry.io/feedback/?feedbackSlug=screenr-ios%3A123&project=1",
                "https://artisanal-software.sentry.io/issues/123/")):
            with self.subTest(reference=reference):
                self.call_log.unlink(missing_ok=True)
                result = self.run_helper("fetch_feedback_bundle.sh", reference,
                                         "--out", str(self.root / f"feedback-{index}"))
                self.assertEqual(result.returncode, 0, result.stderr)
                view = next(call for call in self.calls("sentry") if call[:2] == ["issue", "view"])
                self.assertEqual(view[2], "123")

    def test_feedback_fetch_rejects_other_projects_and_unreadable_references(self) -> None:
        result = self.run_helper("fetch_feedback_bundle.sh", "123", "--out", str(self.root / "server"),
                                 extra_environment={"FAKE_SENTRY_PROJECT": "screenr-server"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not screenr-ios feedback", result.stderr)
        self.assertFalse(any(call[:2] == ["issue", "events"] for call in self.calls("sentry")))

        self.call_log.unlink(missing_ok=True)
        result = self.run_helper("fetch_feedback_bundle.sh", "SCREENR-IOS-ABC", "--out", str(self.root / "short"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("expected a feedback URL", result.stderr)
        self.assertFalse(any(call[:2] == ["issue", "view"] for call in self.calls("sentry")))

    def test_feedback_fallback_rejects_no_events(self) -> None:
        result = self.run_helper("fetch_feedback_bundle.sh", "123", "--out", str(self.root / "feedback"),
                                 extra_environment={"FAKE_SENTRY_EMPTY_EVENTS": "1", "FAKE_SENTRY_API_MATCH": "/events/",
                                                    "FAKE_SENTRY_API_MODE": "empty"})

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("No representative events", result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_attachment_command_lists_only_by_default(self) -> None:
        result = self.run_helper("download_event_attachments.sh", "--event", "event-1",
                                 "--issue-json", str(self.write_issue_json("screenr-server")))

        self.assertEqual(result.returncode, 0, result.stderr)
        api_calls = [call for call in self.calls("sentry") if call[0] == "api"]
        self.assertEqual(api_calls, [["api", "projects/artisanal-software/screenr-server/events/event-1/attachments/",
                                      "--json"]])
        self.assertIn("app.ndjson", result.stdout)
        self.assertIn("2 attachment(s)", result.stdout)

    def test_attachment_command_rejects_issues_outside_screenr(self) -> None:
        result = self.run_helper("download_event_attachments.sh", "--event", "event-1",
                                 "--issue-json", str(self.write_issue_json("podhaven")))

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not for Screenr", result.stderr)
        self.assertFalse(any(call[0] == "api" for call in self.calls("sentry")))

    def test_attachment_command_downloads_only_explicit_names(self) -> None:
        output = self.root / "attachments"
        result = self.run_helper("download_event_attachments.sh", "--event", "event-1",
                                 "--issue-json", str(self.write_issue_json()), "--dir", str(output),
                                 "--name", "app.ndjson")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((output / "app.ndjson").read_bytes(), b' {"message":"one"}\r\n{"message":"two"}\n')
        self.assertEqual([path.name for path in output.iterdir()], ["app.ndjson"])

    def test_attachment_command_contains_hostile_filenames(self) -> None:
        output = self.root / "attachments"
        result = self.run_helper("download_event_attachments.sh", "--event", "event-1",
                                 "--issue-json", str(self.write_issue_json()), "--dir", str(output), "--all")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "escape.txt").exists())
        self.assertEqual(sorted(path.name for path in output.iterdir()), ["app.ndjson", "attachment-2-escape.txt"])

    def test_required_api_responses_fail_clearly(self) -> None:
        cases = (
            ("http", "HTTP 403"), ("json", "invalid JSON"),
            ("type", "expected"), ("row", "expected"),
            ("fields", "expected"), ("bare", "envelope"),
            ("status", "status"), ("missing_body", "body"), ("exit", "CLI"),
        )
        for target in ("attachments", "events"):
            for mode, diagnostic in cases:
                with self.subTest(target=target, mode=mode):
                    output = self.root / f"bad-{target}-{mode}"
                    environment = {"FAKE_SENTRY_API_MATCH": f"/{target}/",
                                   "FAKE_SENTRY_API_MODE": mode, "FAKE_SENTRY_EMPTY_EVENTS": "1"}
                    if target == "attachments":
                        result = self.run_helper("download_event_attachments.sh", "--event", "event-1",
                                                 "--issue-json", str(self.write_issue_json()),
                                                 "--dir", str(output), "--all", extra_environment=environment)
                    else:
                        result = self.run_helper("fetch_feedback_bundle.sh", "screenr-ios:123", "--out", str(output),
                                                 extra_environment=environment)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(diagnostic, result.stderr)
                    self.assertNotIn("Traceback", result.stderr)
                    self.assertNotIn("0 attachment(s)", result.stdout)
                    self.assertFalse((output / "app.ndjson").exists())
                    self.assertFalse((output / "event_event-1.json").exists())

    def test_optional_evidence_failure_is_unavailable_not_empty(self) -> None:
        for target, script, filename in (
            ("tags/environment", "fetch_issue_bundle.sh", "tags_environment.json"),
            ("activities", "fetch_feedback_bundle.sh", "activities.json"),
            ("notes", "fetch_feedback_bundle.sh", "notes.json"),
        ):
            for mode in ("http", "json", "type", "row", "exit"):
                with self.subTest(target=target, mode=mode):
                    output = self.root / f"optional-{filename}-{mode}"
                    result = self.run_helper(script, "123", "--out", str(output),
                                             extra_environment={"FAKE_SENTRY_API_MATCH": f"/{target}/",
                                                                "FAKE_SENTRY_API_MODE": mode})
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("unavailable", result.stderr)
                    self.assertIn("unavailable", result.stdout)
                    self.assertNotIn("Traceback", result.stderr)
                    self.assertFalse((output / filename).exists())

    def test_empty_api_lists_are_successful_evidence(self) -> None:
        for script, target, filename, expected in (
            ("fetch_issue_bundle.sh", "tags/environment", "tags_environment.json", []),
            ("fetch_feedback_bundle.sh", "activities", "activities.json", {"activity": []}),
            ("fetch_feedback_bundle.sh", "notes", "notes.json", []),
            ("fetch_feedback_bundle.sh", "attachments", "attachments.json", []),
        ):
            with self.subTest(target=target):
                output = self.root / filename
                result = self.run_helper(script, "123", "--out", str(output),
                                         extra_environment={"FAKE_SENTRY_API_MATCH": f"/{target}/",
                                                            "FAKE_SENTRY_API_MODE": "empty"})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads((output / filename).read_text()), expected)
                self.assertNotIn("unavailable", result.stdout + result.stderr)

        result = self.run_helper("download_event_attachments.sh", "--event", "event-1",
                                 "--issue-json", str(self.write_issue_json()),
                                 extra_environment={"FAKE_SENTRY_API_MATCH": "/attachments/",
                                                    "FAKE_SENTRY_API_MODE": "empty"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("0 attachment(s)", result.stdout)


class RelatedErrorSearchTests(SentryHelperTests):
    def test_search_covers_both_projects_and_summarizes_matching_events(self) -> None:
        output = self.root / "search.json"

        result = self.run_helper("search_related_errors.sh", "--period", "90d", "--query", "request_id:request-1",
                                 "--out", str(output), "--limit", "3")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.read_text())["data"][0]["issue"], "SCREENR-SERVER-ABC")
        self.assertIn("Matched 1 events", result.stdout)
        self.assertIn("screenr-server  SCREENR-SERVER-ABC  Example failure  request_id=request-1  user.id=user-1",
                      result.stdout)
        explore = next(call for call in self.calls("sentry") if call[:1] == ["explore"])
        self.assertEqual(explore[1:4], ["artisanal-software/", "--dataset", "errors"])
        for option, value in (("--query", "project:[screenr-ios,screenr-server] request_id:request-1"),
                              ("--period", "90d"), ("--limit", "3")):
            self.assertEqual(explore[explore.index(option) + 1], value)

    def test_search_requires_a_period_query_and_fresh_output_before_requests(self) -> None:
        output = self.root / "search.json"
        for arguments in (("--query", "request_id:request-1", "--out", str(output)),
                          ("--period", "90d", "--out", str(output)),
                          ("--period", "90d", "--query", "request_id:request-1")):
            with self.subTest(arguments=arguments):
                result = self.run_helper("search_related_errors.sh", *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Usage: search_related_errors.sh", result.stderr)
        output.write_text("{}")
        result = self.run_helper("search_related_errors.sh", "--period", "90d", "--query", "request_id:request-1",
                                 "--out", str(output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not already exist", result.stderr)
        self.assertEqual(output.read_text(), "{}")
        self.assertEqual(self.calls(), [])


class ServerJournalTests(SentryHelperTests):
    def journal(self, *arguments: str, output: Path | None = None, **environment: str):
        output = output or self.root / "journal.txt"
        return output, self.run_helper(
            "fetch_server_journal.py", "--host", "root@example.invalid", "--since", "2026-11-08T20:00:00Z",
            "--until", "2026-11-08T20:30:00Z", "--out", str(output), *arguments,
            extra_environment={"FAKE_SSH_OUTPUT": JOURNAL, **environment})

    def test_journal_window_is_saved_and_counted_without_printing_lines(self) -> None:
        output, result = self.journal("--request-id", "request-1")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(output.read_text(), JOURNAL.split("--- window ---\n", 1)[1])
        self.assertIn("Oldest kept line: 2026-11-08T19:59:59.000001+00:00", result.stdout)
        self.assertNotIn("earlier lines are gone", result.stdout)
        self.assertIn("Lines in window: 5; failure lines: 3", result.stdout)
        self.assertIn("    request failed: 2\n    worker failed: 1\n", result.stdout)
        self.assertIn("Failure lines for request request-1: 1\n    request failed: 1\n", result.stdout)
        self.assertNotIn("DatabaseError", result.stdout + result.stderr)

    def test_journal_reads_only_the_screenr_units_in_batch_mode(self) -> None:
        _, result = self.journal()

        self.assertEqual(result.returncode, 0, result.stderr)
        [call] = self.calls("ssh")
        self.assertEqual(call[:5], ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "root@example.invalid"])
        [remote] = call[5:]
        journal = "journalctl -u screenr-web -u screenr-worker --no-pager -q -o short-iso-precise"
        self.assertEqual(remote, f"{journal} | head -n 1; echo '--- window ---'; "
                                 f"{journal} --since 2026-11-08T20:00:00Z --until 2026-11-08T20:30:00Z")

    def test_journal_says_when_the_window_starts_before_the_kept_lines(self) -> None:
        for head in ("2026-11-08T20:10:00.000001+00:00 host node[1]: Ready\n", ""):
            with self.subTest(head=head):
                output, result = self.journal(output=self.root / f"journal-{bool(head)}.txt",
                                              FAKE_SSH_OUTPUT=head + "--- window ---\n")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("earlier lines are gone", result.stdout)
                self.assertIn("Lines in window: 0; failure lines: 0", result.stdout)
                self.assertEqual(output.read_text(), "")

    def test_journal_rejects_unsafe_values_before_connecting(self) -> None:
        cases = (
            ("--host", "-oProxyCommand=touch", "USER@HOST"),
            ("--host", "root@host;reboot", "USER@HOST"),
            ("--since", "2026-11-08 20:00:00", "UTC time"),
            ("--since", "2026-11-08T20:00:00Z;reboot", "UTC time"),
            ("--request-id", "request-1'; reboot; '", "request ID"),
        )
        for option, value, diagnostic in cases:
            with self.subTest(option=option, value=value):
                arguments = {"--host": "root@example.invalid", "--since": "2026-11-08T20:00:00Z",
                             "--until": "2026-11-08T20:30:00Z", "--out": str(self.root / "journal.txt")}
                arguments[option] = value
                result = self.run_helper("fetch_server_journal.py",
                                         *[f"{name}={given}" for name, given in arguments.items()])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(diagnostic, result.stderr)
        _, result = self.journal("--until", "2026-11-08T19:00:00Z")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--since must come before --until", result.stderr)
        self.assertEqual(self.calls("ssh"), [])

    def test_journal_keeps_an_existing_output_file(self) -> None:
        output = self.root / "journal.txt"
        output.write_text("earlier")

        _, result = self.journal(output=output)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not already exist", result.stderr)
        self.assertEqual(output.read_text(), "earlier")
        self.assertEqual(self.calls("ssh"), [])

    def test_journal_failures_stop_without_an_output_file(self) -> None:
        for index, (environment, diagnostic) in enumerate((
                ({"FAKE_SSH_EXIT": "255"}, "exit status 255"),
                ({"FAKE_SSH_OUTPUT": "partial reply\n"}, "no window separator"),
                ({"FAKE_SSH_OUTPUT": "garbled\n--- window ---\n"}, "no readable time"))):
            with self.subTest(environment=environment):
                output, result = self.journal(output=self.root / f"journal-{index}.txt", **environment)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(diagnostic, result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertFalse(output.exists())


def log_line(time: str, message: str, level: str = "info", category: str = "app", launch: str = "launch-2",
             **fields: object) -> str:
    """One synthetic line of the app's log file, as ios/README.md#logging describes it."""
    return json.dumps({"time": time, "level": level, "category": category, "message": message,
                       "launch": launch, "fields": fields}, sort_keys=True) + "\n"


def request_line(time: str, request_id: str, level: str = "info", **outcome: object) -> str:
    return log_line(time, "Request finished", level, "api", method="GET", route="/api/screenr/screen",
                    request_id=request_id, duration_ms=120, **outcome)


class LogTailSummaryTests(SentryHelperTests):
    def summarize(self, files: dict[str, str], *arguments: str) -> subprocess.CompletedProcess[str]:
        paths = []
        for name, body in files.items():
            path = self.root / name
            path.write_text(body)
            paths.append(str(path))
        return self.run_helper("summarize_log_tails.py", *arguments, *paths)

    def test_summary_marks_the_feedback_launch_and_lists_the_window_and_its_failed_calls(self) -> None:
        tail = (log_line("2026-11-09T22:00:00.000Z", "Registered for pushes", launch="launch-1")
                + request_line("2026-11-09T23:40:30.000Z", "request-1", status=200)
                + request_line("2026-11-09T23:45:00.250Z", "request-2", "warning", status=503)
                + request_line("2026-11-09T23:46:00.000Z", "request-3", "warning", outcome="failed")
                + request_line("2026-11-09T23:47:00.000Z", "request-4", status=404)
                + log_line("2026-11-09T23:49:59.500Z", "Sending feedback", screenshots=1)
                + log_line("2026-11-09T23:52:00.000Z", "Registered for pushes"))

        result = self.summarize({"app.ndjson": tail}, "--at", "2026-11-09T23:50:00Z")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("app.ndjson: 7 lines, 0 unreadable\n", result.stdout)
        self.assertIn("its last line is 2 min after the feedback", result.stdout)
        self.assertIn("    launch-1  2026-11-09T22:00:00.000Z to 2026-11-09T22:00:00.000Z  1 lines\n", result.stdout)
        self.assertIn("    launch-2  2026-11-09T23:40:30.000Z to 2026-11-09T23:52:00.000Z  6 lines"
                      "  <- the feedback's launch\n", result.stdout)
        self.assertIn("Sending feedback: 2026-11-09T23:49:59.500Z, 0.5 s before the feedback", result.stdout)
        self.assertIn("Window 2026-11-09T23:40:00.000Z to 2026-11-09T23:51:00.000Z: 5 lines (info 3, warning 2)",
                      result.stdout)
        self.assertIn("    2026-11-09T23:45:00.250Z  warning  api  Request finished  duration_ms=120 method=GET "
                      "request_id=request-2 route=/api/screenr/screen status=503\n", result.stdout)
        window = result.stdout.split("  Window ", 1)[1]
        self.assertNotIn("22:00:00", window)
        self.assertNotIn("23:52:00", window)
        failures = window.split("Failed API calls in the window: 3\n", 1)[1]
        self.assertEqual(failures, (
            "    2026-11-09T23:45:00.250Z  GET /api/screenr/screen  status 503  request_id=request-2\n"
            "    2026-11-09T23:46:00.000Z  GET /api/screenr/screen  no answer  request_id=request-3\n"
            "    2026-11-09T23:47:00.000Z  GET /api/screenr/screen  status 404  request_id=request-4\n"))

    def test_summary_counts_unreadable_lines_and_neutralizes_control_characters(self) -> None:
        tail = ("not json\n[]\n" + json.dumps({"time": "yesterday", "message": "skipped line"}) + "\n\n"
                + log_line("2026-11-09T23:49:00.000Z", "Shown \x1b[2J", detail="x" * 300))

        result = self.summarize({"app.ndjson": tail}, "--at", "2026-11-09T23:50:00Z")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("app.ndjson: 1 lines, 3 unreadable", result.stdout)
        self.assertNotIn("\x1b", result.stdout)
        self.assertIn("Shown ?[2J", result.stdout)
        self.assertIn(f"detail={'x' * 200}…", result.stdout)
        self.assertNotIn("x" * 201, result.stdout)
        self.assertNotIn("not json", result.stdout)
        self.assertNotIn("skipped line", result.stdout)

    def test_summary_shows_each_file_and_how_far_an_old_tail_is_from_the_feedback(self) -> None:
        files = {"app.ndjson": log_line("2026-11-09T20:50:00.000Z", "Registered for pushes"),
                 "notifications.ndjson": ""}

        result = self.summarize(files, "--at", "2026-11-09T23:50:00Z")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("its last line is 3.0 h before the feedback", result.stdout)
        self.assertIn("Sending feedback: not in this log", result.stdout)
        self.assertIn("0 lines\n  Failed API calls in the window: 0\nnotifications.ndjson: 0 lines, 0 unreadable\n",
                      result.stdout)

        widened = self.summarize(files, "--at", "2026-11-09T23:50:00Z", "--before", "240")
        self.assertIn(": 1 lines (info 1)", widened.stdout)

    def test_summary_rejects_bad_times_and_missing_files(self) -> None:
        existing = self.root / "app.ndjson"
        existing.write_text("")
        for arguments, diagnostic in (
                (("--at", "2026-11-09 23:50:00", str(existing)), "expected a time with a zone"),
                (("--at", "2026-13-09T23:50:00Z", str(existing)), "expected a time with a zone"),
                (("--at", "2026-11-09T23:50:00Z", "--before", "-5", str(existing)), "expected minutes"),
                (("--at", "2026-11-09T23:50:00Z", str(self.root / "missing.ndjson")), "no such log tail")):
            with self.subTest(arguments=arguments):
                result = self.run_helper("summarize_log_tails.py", *arguments)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(diagnostic, result.stderr)
                self.assertNotIn("Traceback", result.stderr)


class TrackingIssueTests(SentryHelperTests):
    def find(self, *arguments: str, issues: list[dict], **environment: str):
        pages = [{"data": {"repository": {"issues": {"nodes": issues[:2]}}}},
                 {"data": {"repository": {"issues": {"nodes": issues[2:]}}}}]
        return self.run_helper("find_tracking_issues.py", *arguments,
                               extra_environment={"FAKE_GH_OUTPUT": json.dumps(pages), **environment})

    def test_issue_matches_trusted_markers_and_links_and_reports_analysis(self) -> None:
        issues = [
            {"number": 1, "title": "Triage Sentry issue SCREENR-IOS-2", "state": "OPEN", "stateReason": None,
             "body": "<!-- sentry-issue:123 -->\nIntake.", "author": ACTIONS_BOT},
            {"number": 2, "title": "Fix the hang", "state": "CLOSED", "stateReason": "COMPLETED",
             "body": "<!-- sentry-issue:123 -->\n" + FINDINGS, "author": OWNER},
            {"number": 3, "title": "Older analysis", "state": "CLOSED", "stateReason": "NOT_PLANNED",
             "body": "See https://artisanal-software.sentry.io/issues/123/.\n## Sentry closeout\n", "author": OWNER},
            {"number": 4, "title": "Another issue", "state": "OPEN", "stateReason": None,
             "body": "<!-- sentry-issue:1234 -->\nhttps://artisanal-software.sentry.io/issues/1234/",
             "author": OWNER},
            {"number": 5, "title": "Planted", "state": "OPEN", "stateReason": None,
             "body": "<!-- sentry-issue:123 -->\n" + FINDINGS, "author": STRANGER},
        ]

        result = self.find("--issue", "123", issues=issues)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, (
            "Tracking issues for Sentry issue 123 in jubishop/screenr:\n"
            "  #1  open  marker, not analyzed  Triage Sentry issue SCREENR-IOS-2\n"
            "  #2  closed (completed)  marker, analyzed  Fix the hang\n"
            "  #3  closed (not planned)  link only, analyzed before the marker  Older analysis\n"
            "Ignored #5, opened by stranger, who is neither the intake bot nor jubishop.\n"))
        [call] = self.calls("gh")
        self.assertEqual(call[:4], ["api", "graphql", "--paginate", "--slurp"])
        self.assertIn("owner=jubishop", call)
        self.assertIn("name=screenr", call)

    def test_feedback_matches_its_marker_and_intake_link(self) -> None:
        link = "https://artisanal-software.sentry.io/feedback/?feedbackSlug=screenr-ios%3A77&project=1"
        issues = [
            {"number": 7, "title": "Triage Sentry feedback SCREENR-IOS-1", "state": "OPEN", "stateReason": None,
             "body": "<!-- sentry-feedback:screenr-ios:77 -->\n" + link, "author": ACTIONS_BOT},
            {"number": 8, "title": "Linked", "state": "OPEN", "stateReason": None,
             "body": f"- [SCREENR-IOS-1]({link})\n<!-- analyze-sentry-feedback-findings:start -->\n"
                     "<!-- analyze-sentry-feedback-findings:end -->", "author": OWNER},
            {"number": 9, "title": "Error issue", "state": "OPEN", "stateReason": None,
             "body": "<!-- sentry-issue:77 -->", "author": OWNER},
            {"number": 10, "title": "Longer ID", "state": "OPEN", "stateReason": None,
             "body": link.replace("%3A77", "%3A778"), "author": OWNER},
        ]

        result = self.find("--feedback", "77", issues=issues)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("  #7  open  marker, not analyzed", result.stdout)
        self.assertIn("  #8  open  link only, analyzed", result.stdout)
        self.assertNotIn("#9", result.stdout)
        self.assertNotIn("#10", result.stdout)

    def test_repository_comes_from_gh_repo_and_its_owner_is_trusted(self) -> None:
        issues = [{"number": 1, "title": "Fork", "state": "OPEN", "stateReason": None,
                   "body": "<!-- sentry-issue:123 -->", "author": {"__typename": "User", "login": "Forker"}}]

        result = self.find("--issue", "123", issues=issues, GH_REPO="forker/screenr")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("in forker/screenr:\n  #1  open", result.stdout)

    def test_several_ids_share_one_issue_list(self) -> None:
        issues = [{"number": 1, "title": "First", "state": "OPEN", "stateReason": None,
                   "body": "<!-- sentry-issue:123 -->", "author": ACTIONS_BOT},
                  {"number": 2, "title": "Second", "state": "OPEN", "stateReason": None,
                   "body": "<!-- sentry-issue:456 -->", "author": ACTIONS_BOT}]

        result = self.find("--issue", "123", "456", "789", issues=issues)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, (
            "Tracking issues for Sentry issue 123 in jubishop/screenr:\n  #1  open  marker, not analyzed  First\n"
            "Tracking issues for Sentry issue 456 in jubishop/screenr:\n  #2  open  marker, not analyzed  Second\n"
            "Tracking issues for Sentry issue 789 in jubishop/screenr:\n  none\n"))
        self.assertEqual(len(self.calls("gh")), 1)

    def test_no_match_says_none(self) -> None:
        result = self.find("--issue", "123", issues=[])

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "Tracking issues for Sentry issue 123 in jubishop/screenr:\n  none\n")

    def test_failures_and_bad_input_stop_clearly(self) -> None:
        result = self.find("--issue", "123", issues=[], FAKE_GH_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("gh could not list the issues", result.stderr)

        for output in ("not json", json.dumps([{"data": {}}]), json.dumps([{"data": {"repository": {"issues": {
                "nodes": [{"title": "no number"}]}}}}])):
            with self.subTest(output=output):
                result = self.run_helper("find_tracking_issues.py", "--issue", "123",
                                         extra_environment={"FAKE_GH_OUTPUT": output})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("unexpected issue list", result.stderr)
                self.assertNotIn("Traceback", result.stderr)

        self.call_log.unlink(missing_ok=True)
        result = self.run_helper("find_tracking_issues.py", "--issue", "SCREENR-IOS-2")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("numeric Sentry ID", result.stderr)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
