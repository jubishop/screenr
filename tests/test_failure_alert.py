"""Exercise failure alerts with fake systemd state and Resend, and check the units that start them."""
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
ALERT = ROOT / 'ops/failure-alert.py'
FAILED = {'ActiveState': 'failed', 'SubState': 'failed', 'Result': 'exit-code'}


class FailureAlertTests(unittest.TestCase):
    def setUp(self):
        self.environment = {
            'RESEND_API_KEY': 'fixture-email-secret',
            'EMAIL_FROM': 'Screenr <screenr@example.com>',
            'BACKUP_ALERT_TO': 'owner@example.com',
        }
        self.commands = []
        self.requests = []

    def execute(self, *arguments, state=FAILED, mail=None):
        """Run the alert CLI. mail is a list of Resend responses or errors, one per attempt."""
        responses = iter(mail or [b'{"id":"email-accepted"}'])

        def run(command, **options):
            self.commands.append(list(command))
            if isinstance(state, BaseException):
                raise state
            output = ''.join(f'{key}={value}\n' for key, value in state.items())
            return subprocess.CompletedProcess(command, 0, stdout=output)

        def request(req, timeout):
            self.assertGreater(timeout, 0)
            self.requests.append(req)
            response = next(responses)
            if isinstance(response, Exception):
                raise response
            return io.BytesIO(response)

        output, errors = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, self.environment, clear=True), \
                patch('sys.argv', [str(ALERT), *arguments]), \
                patch('subprocess.run', run), patch('urllib.request.urlopen', request), \
                patch('time.sleep'), redirect_stdout(output), redirect_stderr(errors):
            try:
                runpy.run_path(str(ALERT), run_name='__main__')
            except SystemExit as result:
                code = result.code or 0
            else:
                code = 0
        return code, output.getvalue(), errors.getvalue()

    def message(self):
        self.assertEqual(len(self.requests), 1)
        req = self.requests[0]
        self.assertEqual(req.full_url, 'https://api.resend.com/emails')
        self.assertEqual(req.get_method(), 'POST')
        self.assertEqual(req.get_header('Authorization'), 'Bearer fixture-email-secret')
        self.assertTrue(req.get_header('Idempotency-key').startswith('screenr-failure-alert/'))
        message = json.loads(req.data)
        self.assertEqual(message['from'], 'Screenr <screenr@example.com>')
        self.assertEqual(message['to'], ['owner@example.com'])
        return message

    def test_failed_backup_emails_the_owner(self):
        code, output, errors = self.execute('screenr-backup.service')
        self.assertEqual(code, 0, errors)
        self.assertEqual(self.commands, [['systemctl', 'show', 'screenr-backup.service',
                                          '--property=ActiveState,SubState,Result']])
        message = self.message()
        self.assertIn('backup failed', message['subject'])
        self.assertIn('journalctl -u screenr-backup.service', message['text'])
        self.assertIn('exit-code', message['text'])
        self.assertIn('accepted by Resend', output)
        self.assertNotIn('fixture-email-secret', output + errors)

    def test_failed_restore_check_emails_the_owner(self):
        code, _, errors = self.execute('screenr-restore-check.service')
        self.assertEqual(code, 0, errors)
        message = self.message()
        self.assertIn('restore check failed', message['subject'])
        self.assertIn('journalctl -u screenr-restore-check.service', message['text'])

    def test_stale_backup_check_emails_the_owner(self):
        code, _, errors = self.execute('screenr-backup-age.service')
        self.assertEqual(code, 0, errors)
        message = self.message()
        self.assertIn('30 hours', message['subject'])
        self.assertIn('30 hours', message['text'])
        self.assertIn('journalctl -u screenr-backup-age.service', message['text'])

    def test_service_at_its_restart_limit_emails_the_owner(self):
        for unit, name in [('screenr-web.service', 'web application'),
                           ('screenr-worker.service', 'email worker'),
                           ('screenr-db.service', 'database')]:
            with self.subTest(unit=unit):
                self.requests.clear()
                code, _, errors = self.execute(unit, state={**FAILED, 'Result': 'start-limit-hit'})
                self.assertEqual(code, 0, errors)
                message = self.message()
                self.assertIn(name, message['subject'])
                self.assertIn('restart limit', message['text'])
                self.assertIn(f'systemctl reset-failed {unit}', message['text'])

    def test_failure_before_an_automatic_restart_sends_nothing(self):
        # systemd starts OnFailure= units before each automatic restart, too.
        for state in [{'ActiveState': 'failed', 'SubState': 'failed-before-auto-restart',
                       'Result': 'exit-code'},
                      {'ActiveState': 'activating', 'SubState': 'auto-restart',
                       'Result': 'exit-code'},
                      {'ActiveState': 'active', 'SubState': 'running', 'Result': 'success'}]:
            with self.subTest(state=state['SubState']):
                code, output, errors = self.execute('screenr-web.service', state=state)
                self.assertEqual(code, 0, errors)
                self.assertIn('no alert', output)
                self.assertEqual(self.requests, [])

    def test_retries_lost_responses_with_the_same_payload_and_key(self):
        code, _, errors = self.execute(
            'screenr-backup.service',
            mail=[URLError('lost'), HTTPError('https://api.resend.com/emails', 503, 'busy', {}, None),
                  b'{"id":"email-accepted"}'])
        self.assertEqual(code, 0, errors)
        self.assertEqual(len(self.requests), 3)
        self.assertEqual(len({req.data for req in self.requests}), 1)
        self.assertEqual(len({req.get_header('Idempotency-key') for req in self.requests}), 1)

    def test_reports_failure_when_delivery_never_succeeds(self):
        code, output, errors = self.execute(
            'screenr-backup.service', mail=[URLError('fixture-email-secret')] * 3 + [b'{}'])
        self.assertEqual(code, 1)
        self.assertEqual(len(self.requests), 3)
        self.assertIn('Failure alert for screenr-backup.service failed', errors)
        self.assertNotIn('fixture-email-secret', output + errors)
        for response in [b'{}', b'not json']:
            with self.subTest(response=response):
                self.requests.clear()
                code, _, _ = self.execute('screenr-backup.service', mail=[response] * 3)
                self.assertEqual(code, 1)

    def test_definite_rejection_stops_without_retrying(self):
        rejection = HTTPError('https://api.resend.com/emails', 401, 'fixture-email-secret', {}, None)
        code, output, errors = self.execute('screenr-backup.service', mail=[rejection])
        self.assertEqual(code, 1)
        self.assertEqual(len(self.requests), 1)
        self.assertIn('HTTP 401', errors)
        self.assertNotIn('fixture-email-secret', output + errors)

    def test_refuses_other_units_before_reading_state(self):
        for unit in ['sshd.service', 'caddy.service', 'screenr-backup.timer',
                     'screenr-web.service; true', '../screenr-web.service', '']:
            with self.subTest(unit=unit):
                code, _, errors = self.execute(unit)
                self.assertNotEqual(code, 0)
                self.assertEqual(self.commands, [])
                self.assertEqual(self.requests, [])

    def test_missing_mail_configuration_is_reported(self):
        for name in self.environment.copy():
            with self.subTest(name=name):
                saved = self.environment.pop(name)
                code, _, errors = self.execute('screenr-backup.service')
                self.environment[name] = saved
                self.assertEqual(code, 1)
                self.assertIn(name, errors)
                self.assertEqual(self.requests, [])

    def test_unreadable_unit_state_is_reported(self):
        for error in [subprocess.CalledProcessError(1, 'systemctl'), FileNotFoundError('systemctl')]:
            with self.subTest(error=type(error).__name__):
                code, _, errors = self.execute('screenr-backup.service', state=error)
                self.assertEqual(code, 1)
                self.assertIn('Failure alert for screenr-backup.service failed', errors)
                self.assertEqual(self.requests, [])

    def test_dry_run_prints_the_alert_without_sending(self):
        code, output, errors = self.execute('--dry-run', 'screenr-backup.service')
        self.assertEqual(code, 0, errors)
        self.assertIn('Dry run', output)
        self.assertIn('backup failed', output)
        self.assertIn('journalctl -u screenr-backup.service', output)
        self.assertNotIn('owner@example.com', output)
        self.assertNotIn('fixture-email-secret', output)
        self.assertEqual(self.requests, [])
        code, output, _ = self.execute('--dry-run', 'screenr-web.service',
                                       state={'ActiveState': 'active', 'SubState': 'running',
                                              'Result': 'success'})
        self.assertEqual(code, 0)
        self.assertIn('no alert', output)


def unit_file(name):
    """Parse a systemd unit into {section: {key: [values]}}."""
    sections, current = {}, None
    for line in (ROOT / 'ops' / name).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('['):
            current = sections.setdefault(line.strip('[]'), {})
            continue
        key, value = line.split('=', 1)
        current.setdefault(key, []).append(value)
    return sections


def daily_utc_seconds(timer):
    day, clock, zone = unit_file(timer)['Timer']['OnCalendar'][0].split()
    if day != '*-*-*' or zone != 'UTC':
        raise AssertionError(f'{timer} is not a daily UTC timer')
    hours, minutes, seconds = map(int, clock.split(':'))
    return hours * 3600 + minutes * 60 + seconds


class FailureAlertUnitTests(unittest.TestCase):
    MONITORED = ['screenr-backup.service', 'screenr-restore-check.service',
                 'screenr-backup-age.service', 'screenr-web.service', 'screenr-worker.service',
                 'screenr-db.service']

    def test_monitored_units_start_the_alert_on_failure(self):
        for name in self.MONITORED:
            with self.subTest(unit=name):
                self.assertEqual(unit_file(name)['Unit'].get('OnFailure'),
                                 ['screenr-alert@%n.service'])

    def test_alert_unit_runs_the_checked_script_without_root(self):
        alert = unit_file('screenr-alert@.service')
        service = alert['Service']
        self.assertNotIn('OnFailure', alert['Unit'])
        self.assertNotIn('Install', alert)
        self.assertEqual(service['Type'], ['oneshot'])
        self.assertEqual(service['ExecStart'],
                         ['/usr/bin/python3 /opt/screenr/current/ops/failure-alert.py %i'])
        self.assertTrue(ALERT.is_file())
        self.assertEqual(service['EnvironmentFile'], ['/etc/screenr/backup.env'])
        self.assertEqual(service.get('DynamicUser'), ['yes'])
        self.assertNotIn('User', service)

    def test_daily_stale_backup_check_reuses_the_age_check(self):
        service = unit_file('screenr-backup-age.service')['Service']
        self.assertEqual(service['ExecStart'],
                         ['/usr/bin/python3 /opt/screenr/current/ops/check-backup-age.py'])
        self.assertTrue((ROOT / 'ops/check-backup-age.py').is_file())
        self.assertEqual(service['User'], ['screenr-db'])
        self.assertEqual(service['EnvironmentFile'], ['/etc/screenr/backup.env'])
        self.assertIn('RESTIC_CACHE_DIR=/var/lib/screenr-backup/cache', service['Environment'])
        timer = unit_file('screenr-backup-age.timer')
        self.assertEqual(timer['Timer']['Persistent'], ['true'])
        self.assertEqual(timer['Install']['WantedBy'], ['timers.target'])

    def test_stale_backup_check_catches_the_first_missed_daily_backup(self):
        # The next check after one missed backup must see an age over 30 hours,
        # even when the last backup started at the end of its randomized delay.
        backup, check = daily_utc_seconds('screenr-backup.timer'), daily_utc_seconds('screenr-backup-age.timer')
        delay = {'10m': 600}[unit_file('screenr-backup.timer')['Timer']['RandomizedDelaySec'][0]]
        offset = (check - backup) % 86400
        self.assertGreater(86400 + offset - delay, 30 * 3600)


if __name__ == '__main__':
    unittest.main()
