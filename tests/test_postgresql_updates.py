"""Exercise the pending PostgreSQL update notice with fake apt output, clock, and Resend."""
import datetime
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch
from urllib.error import URLError

from test_failure_alert import unit_file

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / 'ops/check-postgresql-updates.py'
# A daily check around 16:05 UTC on the day a PostgreSQL minor release appears.
RELEASE_DAY = datetime.datetime(2026, 11, 12, 16, 5, tzinfo=datetime.timezone.utc).timestamp()
DAY = 86400
UBUNTU = ('Listing...\n'
          'alsa-ucm-conf/noble-updates 1.2.10-1ubuntu5.15 all [upgradable from: 1.2.10-1ubuntu5.13]\n'
          'libkrb5-3/noble-updates,noble-security 1.20.1-6ubuntu2.10 amd64 '
          '[upgradable from: 1.20.1-6ubuntu2.7]\n')
SERVER = 'postgresql-18/noble-pgdg 18.7-1.pgdg24.04+1 amd64 [upgradable from: 18.6-1.pgdg24.04+2]\n'
LIBRARY = 'libpq5/noble-pgdg 18.7-1.pgdg24.04+1 amd64 [upgradable from: 18.6-1.pgdg24.04+2]\n'
RELEASE = UBUNTU + LIBRARY + SERVER


class PostgresqlUpdateTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.state = Path(directory.name) / 'screenr-postgresql-updates'
        self.environment = {
            'RESEND_API_KEY': 'fixture-email-secret',
            'EMAIL_FROM': 'Screenr <screenr@example.com>',
            'BACKUP_ALERT_TO': 'owner@example.com',
            'STATE_DIRECTORY': str(self.state),
        }
        self.commands = []
        self.requests = []

    def execute(self, day, apt=RELEASE, *arguments, mail=None):
        """Run the check on a day after RELEASE_DAY. apt is the listing or an exception to raise."""
        responses = iter(mail or [b'{"id":"email-accepted"}'])

        def run(command, **options):
            self.commands.append((list(command), options))
            if isinstance(apt, BaseException):
                raise apt
            return subprocess.CompletedProcess(command, 0, stdout=apt)

        def request(req, timeout):
            self.assertGreater(timeout, 0)
            self.requests.append(req)
            response = next(responses)
            if isinstance(response, Exception):
                raise response
            return io.BytesIO(response)

        output, errors = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, self.environment, clear=True), \
                patch('sys.argv', [str(CHECK), *arguments]), \
                patch('subprocess.run', run), patch('urllib.request.urlopen', request), \
                patch('time.time', return_value=RELEASE_DAY + day * DAY), patch('time.sleep'), \
                redirect_stdout(output), redirect_stderr(errors):
            try:
                runpy.run_path(str(CHECK), run_name='__main__')
            except SystemExit as result:
                code = result.code or 0
            else:
                code = 0
        return code, output.getvalue(), errors.getvalue()

    def messages(self):
        messages = []
        for req in self.requests:
            self.assertEqual(req.full_url, 'https://api.resend.com/emails')
            self.assertEqual(req.get_header('Authorization'), 'Bearer fixture-email-secret')
            message = json.loads(req.data)
            self.assertEqual(message['from'], 'Screenr <screenr@example.com>')
            self.assertEqual(message['to'], ['owner@example.com'])
            messages.append(message)
        return messages

    def saved(self):
        return json.loads((self.state / 'pending.json').read_text())

    def test_update_pending_for_three_days_notifies_the_owner_once(self):
        for day in range(3):
            code, output, errors = self.execute(day)
            self.assertEqual(code, 0, errors)
            self.assertIn('postgresql-18 18.6-1.pgdg24.04+2 -> 18.7-1.pgdg24.04+1', output)
            self.assertEqual(self.requests, [], f'day {day}')
        code, output, errors = self.execute(3)
        self.assertEqual(code, 0, errors)
        [message] = self.messages()
        self.assertEqual(message['subject'], 'Screenr alert: PostgreSQL update pending')
        text = message['text']
        self.assertIn('postgresql-18: 18.6-1.pgdg24.04+2 -> 18.7-1.pgdg24.04+1', text)
        self.assertIn('libpq5: 18.6-1.pgdg24.04+2 -> 18.7-1.pgdg24.04+1', text)
        self.assertIn('2026-11-12', text)
        self.assertIn('docs/restore-and-patching.md#postgresql', text)
        self.assertNotIn('alsa-ucm-conf', text)
        self.assertIn('accepted by Resend', output)
        self.assertNotIn('fixture-email-secret', output + errors)
        for day in (4, 5, 30):
            code, _, errors = self.execute(day)
            self.assertEqual(code, 0, errors)
        self.assertEqual(len(self.requests), 1)

    def test_only_postgresql_repository_updates_count(self):
        for day in (0, 3, 10):
            code, output, errors = self.execute(day, UBUNTU)
            self.assertEqual(code, 0, errors)
            self.assertIn('No PostgreSQL updates pending', output)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.saved(), {})

    def test_one_notice_covers_packages_that_appear_on_different_days(self):
        self.execute(0, UBUNTU + LIBRARY)
        self.execute(1, RELEASE)
        self.execute(2, RELEASE)
        self.assertEqual(self.requests, [])
        code, _, errors = self.execute(3, RELEASE)
        self.assertEqual(code, 0, errors)
        [message] = self.messages()
        self.assertIn('libpq5: 18.6-1.pgdg24.04+2 -> 18.7-1.pgdg24.04+1 (first seen 2026-11-12)',
                      message['text'])
        self.assertIn('postgresql-18: 18.6-1.pgdg24.04+2 -> 18.7-1.pgdg24.04+1 '
                      '(first seen 2026-11-13)', message['text'])
        self.execute(4, RELEASE)
        self.execute(6, RELEASE)
        self.assertEqual(len(self.requests), 1)

    def test_a_newer_release_notifies_again_after_its_own_wait(self):
        self.execute(0)
        self.execute(3)
        self.assertEqual(len(self.requests), 1)
        newer = RELEASE.replace('18.7-1.pgdg24.04+1', '18.8-1.pgdg24.04+1')
        for day in (40, 41, 42):
            self.execute(day, newer)
        self.assertEqual(len(self.requests), 1)
        code, _, errors = self.execute(43, newer)
        self.assertEqual(code, 0, errors)
        self.assertEqual(len(self.requests), 2)
        self.assertIn('postgresql-18: 18.6-1.pgdg24.04+2 -> 18.8-1.pgdg24.04+1',
                      self.messages()[1]['text'])

    def test_installed_updates_leave_the_saved_state(self):
        self.execute(0)
        self.execute(3)
        code, output, errors = self.execute(4, UBUNTU)
        self.assertEqual(code, 0, errors)
        self.assertIn('No PostgreSQL updates pending', output)
        self.assertEqual(self.saved(), {})

    def test_failed_delivery_fails_the_check_and_retries_the_next_day(self):
        self.execute(0)
        code, output, errors = self.execute(3, mail=[URLError('fixture-email-secret')] * 3)
        self.assertEqual(code, 1)
        self.assertEqual(len(self.requests), 3)
        self.assertIn('PostgreSQL update check failed', errors)
        self.assertNotIn('fixture-email-secret', output + errors)
        self.assertFalse(any(entry['notified'] for entry in self.saved().values()))
        code, _, errors = self.execute(4)
        self.assertEqual(code, 0, errors)
        self.assertEqual(len(self.requests), 4)
        self.assertIn('first seen 2026-11-12', self.messages()[-1]['text'])
        self.execute(5)
        self.assertEqual(len(self.requests), 4)

    def test_missing_mail_configuration_keeps_the_first_seen_date(self):
        self.execute(0)
        for name in ('RESEND_API_KEY', 'EMAIL_FROM', 'BACKUP_ALERT_TO'):
            with self.subTest(name=name):
                saved = self.environment.pop(name)
                code, _, errors = self.execute(3)
                self.environment[name] = saved
                self.assertEqual(code, 1)
                self.assertIn(name, errors)
                self.assertEqual(self.requests, [])
                self.assertEqual({entry['since'] for entry in self.saved().values()},
                                 {'2026-11-12'})

    def test_dry_run_prints_the_due_notice_without_sending_or_saving(self):
        code, output, errors = self.execute(0, RELEASE, '--dry-run')
        self.assertEqual(code, 0, errors)
        self.assertIn('No notice due', output)
        self.assertFalse(self.state.exists())
        self.execute(0)
        before = self.saved()
        code, output, errors = self.execute(3, RELEASE, '--dry-run')
        self.assertEqual(code, 0, errors)
        self.assertIn('Dry run; would email the owner', output)
        self.assertIn('PostgreSQL update pending', output)
        self.assertNotIn('owner@example.com', output)
        self.assertNotIn('fixture-email-secret', output)
        self.assertEqual(self.requests, [])
        self.assertEqual(self.saved(), before)

    def test_reads_apt_lists_without_changing_packages_or_passing_secrets(self):
        self.execute(0)
        [(command, options)] = self.commands
        self.assertEqual(command, ['apt', '-o', 'Apt::Cmd::Disable-Script-Warning=true',
                                   'list', '--upgradable'])
        self.assertTrue(options['check'])
        self.assertGreater(options['timeout'], 0)
        self.assertEqual(options['env'], {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'})

    def test_unreadable_updates_fail_the_check(self):
        failures = [subprocess.CalledProcessError(100, 'apt'), FileNotFoundError('apt'),
                    'Listing...\nE: something unexpected\n',
                    'postgresql-18/noble-pgdg 18.7-1.pgdg24.04+1 amd64\n']
        for failure in failures:
            with self.subTest(failure=failure):
                code, _, errors = self.execute(0, failure)
                self.assertEqual(code, 1)
                self.assertIn('PostgreSQL update check failed', errors)
                self.assertEqual(self.requests, [])
                self.assertFalse((self.state / 'pending.json').exists())

    def test_invalid_saved_state_fails_the_check(self):
        self.state.mkdir()
        for content in ['not json', '[]', '{"postgresql-18 18.7": {"since": "soon"}}']:
            with self.subTest(content=content):
                (self.state / 'pending.json').write_text(content)
                code, _, errors = self.execute(3)
                self.assertEqual(code, 1)
                self.assertIn('PostgreSQL update check failed', errors)
                self.assertEqual(self.requests, [])


class PostgresqlUpdateUnitTests(unittest.TestCase):
    def test_daily_check_runs_the_script_without_privileges(self):
        unit = unit_file('screenr-postgresql-updates.service')
        self.assertEqual(unit['Unit']['OnFailure'], ['screenr-alert@%n.service'])
        service = unit['Service']
        self.assertEqual(service['Type'], ['oneshot'])
        self.assertEqual(service['ExecStart'],
                         ['/usr/bin/python3 /opt/screenr/current/ops/check-postgresql-updates.py'])
        self.assertTrue(CHECK.is_file())
        # It needs neither the database files nor systemd's D-Bus API.
        self.assertEqual(service['DynamicUser'], ['yes'])
        self.assertNotIn('User', service)
        self.assertEqual(service['EnvironmentFile'], ['/etc/screenr/backup.env'])
        self.assertEqual(service['StateDirectory'], ['screenr-postgresql-updates'])
        self.assertEqual(service['ProtectSystem'], ['strict'])
        timer = unit_file('screenr-postgresql-updates.timer')
        self.assertTrue(timer['Timer']['OnCalendar'][0].startswith('*-*-* '))
        self.assertEqual(timer['Timer']['Persistent'], ['true'])
        self.assertEqual(timer['Install']['WantedBy'], ['timers.target'])


if __name__ == '__main__':
    unittest.main()
