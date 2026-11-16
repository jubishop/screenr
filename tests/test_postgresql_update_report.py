"""Turn the PostgreSQL updater's status into at most one open issue, through a fake GitHub CLI."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from _process_waits import HANG_SECONDS
from test_failure_alert import daily_utc_seconds

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / 'bin/postgresql-update-report'
WORKFLOW = ROOT / '.github/workflows/postgresql-updates.yml'
TITLE = 'Fix the automatic PostgreSQL update on the server'
NOW = '2026-11-22T11:35:00+00:00'
CHECKED = '2026-11-22T10:05:00+00:00'
REMOVAL = ('Upgrading would remove postgresql-contrib, so it needs a person. '
           'Retrying daily since 2026-11-19.')

# Stands in for the GitHub CLI: logs each call with its standard input, lists
# the fixture's open issues, shows one issue, and files issues and comments.
FAKE_GH = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
base = Path(os.environ["FIXTURE"])
args = sys.argv[1:]
stdin = sys.stdin.read() if "-" in args else ""
with (base / "gh-calls").open("a") as log:
    log.write(json.dumps({"args": args, "stdin": stdin}) + "\n")
if (base / "gh-fails").exists():
    sys.exit(1)
issues = json.loads((base / "issues.json").read_text())
if args[:2] == ["issue", "list"]:
    print(json.dumps([{"number": issue["number"], "title": issue["title"]} for issue in issues]))
elif args[:2] == ["issue", "view"]:
    issue = next(issue for issue in issues if str(issue["number"]) == args[2])
    print(json.dumps({"body": issue["body"], "comments": issue["comments"]}))
elif args[:2] == ["issue", "create"]:
    print("https://github.com/jubishop/screenr/issues/700")
elif args[:2] != ["issue", "comment"]:
    sys.exit(f"unexpected gh call {args}")
'''


def status(result='blocked', message=REMOVAL, checked=CHECKED):
    return {'result': result, 'message': message, 'checked': checked,
            'last_success': '2026-11-18T10:05:00+00:00', 'trouble_since': '2026-11-19',
            'pending': {'postgresql-18 18.8-1.pgdg24.04+1': {'installed': '18.7-1.pgdg24.04+2',
                                                             'since': '2026-11-12'}}}


class ReportTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        tools = self.base / 'bin'
        tools.mkdir()
        (tools / 'gh').write_text(FAKE_GH)
        (tools / 'gh').chmod(0o755)
        self.issues = []
        self.path = self.base / 'postgresql-status.json'

    def report(self, content):
        if content is not None:
            self.path.write_text(content if isinstance(content, str) else json.dumps(content))
        (self.base / 'issues.json').write_text(json.dumps(self.issues))
        environment = {'PATH': f'{self.base / "bin"}:{os.environ["PATH"]}', 'FIXTURE': str(self.base),
                       'GITHUB_SERVER_URL': 'https://github.com', 'GITHUB_REPOSITORY': 'jubishop/screenr',
                       'GITHUB_RUN_ID': '123'}
        return subprocess.run([str(REPORT), str(self.path), '--now', NOW], env=environment, capture_output=True,
                              text=True, timeout=HANG_SECONDS)

    def calls(self):
        log = self.base / 'gh-calls'
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def test_a_working_updater_files_nothing(self):
        for result in ('current', 'updated', 'retrying'):
            with self.subTest(result=result):
                outcome = self.report(status(result, 'No PostgreSQL updates pending.'))
                self.assertEqual(outcome.returncode, 0, outcome.stderr)
                self.assertIn(f'PostgreSQL updater {result}: No PostgreSQL updates pending.', outcome.stdout)
                self.assertEqual(self.calls(), [])

    def test_a_failed_update_only_warns_since_the_server_emailed_the_owner(self):
        outcome = self.report(status('failed', 'Could not restart screenr-db.'))
        self.assertEqual(outcome.returncode, 0, outcome.stderr)
        self.assertIn('::warning::The PostgreSQL update left Screenr unhealthy', outcome.stdout)
        self.assertEqual(self.calls(), [])

    def test_a_blocked_updater_opens_one_labeled_issue(self):
        outcome = self.report(status())
        self.assertEqual(outcome.returncode, 0, outcome.stderr)
        self.assertIn(f'::warning::{REMOVAL}', outcome.stdout)
        lookup, create = self.calls()
        # Only the workflow's own issues count; anyone can open one in a public repository.
        self.assertEqual(lookup['args'][:2], ['issue', 'list'])
        self.assertIn('app/github-actions', lookup['args'])
        self.assertEqual(create['args'], ['issue', 'create', '--title', TITLE, '--label', 'bug', '--label',
                                          'area: ops', '--label', 'p2', '--body-file', '-'])
        body = create['stdin']
        self.assertIn(f'## Problem\n\n{REMOVAL}\n', body)
        self.assertIn('"postgresql-18 18.8-1.pgdg24.04+1"', body)
        self.assertIn('journalctl -u screenr-postgresql-updates.service', body)
        self.assertIn('docs/restore-and-patching.md#postgresql', body)
        self.assertIn('https://github.com/jubishop/screenr/actions/runs/123', body)

    def test_an_open_issue_gets_a_comment_only_for_a_new_problem(self):
        self.issues = [{'number': 690, 'title': TITLE, 'body': f'## Problem\n\n{REMOVAL}\n', 'comments': []}]
        outcome = self.report(status())
        self.assertEqual(outcome.returncode, 0, outcome.stderr)
        self.assertIn('Issue #690 already describes this problem.', outcome.stdout)
        self.assertEqual([call['args'][:2] for call in self.calls()], [['issue', 'list'], ['issue', 'view']])
        newer = 'Could not install the packages: apt-get exited with status 100. Screenr is still healthy.'
        outcome = self.report(status(message=newer))
        self.assertEqual(outcome.returncode, 0, outcome.stderr)
        comment = self.calls()[-1]
        self.assertEqual(comment['args'], ['issue', 'comment', '690', '--body-file', '-'])
        self.assertIn(newer, comment['stdin'])
        self.issues[0]['comments'] = [{'body': comment['stdin']}]
        self.report(status(message=newer))
        self.assertEqual(self.calls()[-1]['args'][:2], ['issue', 'view'])

    def test_a_similar_title_is_not_the_workflows_issue(self):
        self.issues = [{'number': 690, 'title': TITLE + ' again', 'body': REMOVAL, 'comments': []}]
        self.report(status())
        self.assertEqual(self.calls()[-1]['args'][:2], ['issue', 'create'])

    def test_a_stalled_or_unreadable_status_opens_an_issue(self):
        cases = ((status('current', 'No PostgreSQL updates pending.', '2026-11-20T09:30:00+00:00'),
                  'over 50 hours ago'),
                 (None, "could not read the updater's status"),
                 ('', "could not read the updater's status"),
                 ('not json', 'unreadable'),
                 ('[1]', 'unreadable'),
                 ({'result': 'current'}, 'unreadable'))
        for content, reason in cases:
            with self.subTest(content=content):
                self.setUp()
                outcome = self.report(content)
                self.assertEqual(outcome.returncode, 0, outcome.stderr)
                create = self.calls()[-1]
                self.assertEqual(create['args'][:2], ['issue', 'create'])
                self.assertIn(reason, create['stdin'])
        # Within 50 hours, a day's late or skipped workflow run is no problem.
        self.setUp()
        outcome = self.report(status('current', 'No PostgreSQL updates pending.', '2026-11-20T10:00:00+00:00'))
        self.assertEqual((outcome.returncode, self.calls()), (0, []))

    def test_a_github_failure_fails_the_run(self):
        (self.base / 'gh-fails').touch()
        outcome = self.report(status())
        self.assertEqual(outcome.returncode, 1)
        self.assertIn('Could not open or update the issue', outcome.stderr)


class WorkflowTests(unittest.TestCase):
    def test_reads_the_status_after_the_updater_and_records_no_deployment(self):
        workflow = WORKFLOW.read_text()
        hour, minute = 11, 30
        self.assertIn(f'- cron: "{minute} {hour} * * *"', workflow)
        # The updater starts by 10:10 UTC and may wait 30 minutes for the deploy lock.
        self.assertGreater(hour * 3600 + minute * 60, daily_utc_seconds('screenr-postgresql-updates.timer') + 3600)
        self.assertIn('    environment:\n      name: production\n      deployment: false\n', workflow)
        self.assertIn('      issues: write\n', workflow)
        self.assertIn('"$SCREENR_DEPLOY_HOST" postgresql-status > "$status"', workflow)
        self.assertIn('run: bin/postgresql-update-report "$RUNNER_TEMP/postgresql-status.json"', workflow)
        self.assertIn("if: github.repository == 'jubishop/screenr'", workflow)


if __name__ == '__main__':
    unittest.main()
