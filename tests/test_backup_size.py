"""Exercise the backup size monitor CLI with HTTP fakes and real persisted state, and its units."""
import io
import fcntl
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

from test_failure_alert import unit_file

ROOT = Path(__file__).resolve().parents[1]
GIGABYTE = 1_000_000_000


def longest_timer_gap(timer):
    """Return the longest possible time between two runs of a daily UTC timer."""
    settings = unit_file(timer)['Timer']
    day, clock, zone = settings['OnCalendar'][0].split()
    if day != '*-*-*' or zone != 'UTC':
        raise AssertionError(f'{timer} is not a daily UTC timer')
    hours, minutes, seconds = clock.split(':')
    runs = sorted(int(hour) * 3600 + int(minutes) * 60 + int(seconds) for hour in hours.split(','))
    delay = {'10m': 600}[settings['RandomizedDelaySec'][0]]
    # One run starts without its randomized delay and the next with all of it.
    return max((later - earlier) % 86400 or 86400
               for earlier, later in zip(runs, runs[1:] + runs[:1])) + delay


def listing(sizes, *, token=None):
    objects = ''.join(f'<Contents><Key>object-{i}</Key><Size>{size}</Size></Contents>'
                      for i, size in enumerate(sizes))
    cursor = f'<NextContinuationToken>{token}</NextContinuationToken>' if token else ''
    return (f'<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
            f'{objects}<IsTruncated>{str(bool(token)).lower()}</IsTruncated>'
            f'{cursor}</ListBucketResult>').encode()


class BackupSizeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.environment = {
            'STATE_DIRECTORY': str(self.directory),
            'RESTIC_REPOSITORY': 's3:https://fixture.r2.cloudflarestorage.com/backups/prefix',
            'AWS_ACCESS_KEY_ID': 'fixture-access',
            'AWS_SECRET_ACCESS_KEY': 'fixture-secret',
            'RESEND_API_KEY': 'fixture-email-secret',
            'EMAIL_FROM': 'Screenr <screenr@example.com>',
            'BACKUP_ALERT_TO': 'owner@example.com',
        }
        self.requests = []
        self.now = 1_790_000_000

    def execute(self, pages, *, mail=None):
        pages = iter(pages)

        def request(req, timeout):
            self.assertGreater(timeout, 0)
            self.requests.append(req)
            if urlsplit(req.full_url).hostname == 'api.resend.com':
                response = mail if mail is not None else b'{"id":"email-accepted"}'
            else:
                response = next(pages)
            if isinstance(response, Exception):
                raise response
            return io.BytesIO(response)

        output, errors = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, self.environment, clear=True), \
                patch('urllib.request.urlopen', request), \
                patch('time.time', return_value=self.now), patch('time.sleep'), \
                redirect_stdout(output), redirect_stderr(errors):
            try:
                runpy.run_path(str(ROOT / 'ops/check-backup-size.py'), run_name='__main__')
            except SystemExit as result:
                code = result.code or 0
            else:
                code = 0
        return code, output.getvalue(), errors.getvalue()

    def emails(self):
        return [req for req in self.requests if req.full_url == 'https://api.resend.com/emails']

    def state(self):
        return json.loads((self.directory / 'size.json').read_text())

    def test_measures_all_pages_and_the_whole_bucket(self):
        code, output, errors = self.execute([
            listing([400_000_000, 200_000_000], token='a+/='), listing([10, 25])])
        self.assertEqual(code, 0, errors)
        self.assertIn('600000035 bytes', output)
        self.assertEqual(self.state()['bytes'], 600_000_035)
        self.assertEqual(self.state()['objects'], 4)
        self.assertEqual(len(self.emails()), 0)
        queries = [parse_qs(urlsplit(req.full_url).query) for req in self.requests]
        self.assertNotIn('prefix', queries[0])
        self.assertEqual(queries[1]['continuation-token'], ['a+/='])
        for req in self.requests:
            self.assertEqual(urlsplit(req.full_url).path, '/backups')
            self.assertIn('AWS4-HMAC-SHA256', req.get_header('Authorization'))
        self.assertEqual((self.directory / 'size.json').stat().st_mode & 0o777, 0o600)

    def test_warns_once_above_threshold_and_rearms_only_below(self):
        for size in [GIGABYTE, GIGABYTE + 1, 2 * GIGABYTE, GIGABYTE]:
            code, _, errors = self.execute([listing([size])])
            self.assertEqual(code, 0, errors)
        self.assertEqual(len(self.emails()), 1)
        self.execute([listing([GIGABYTE + 2])])
        self.assertEqual(len(self.emails()), 1)
        self.execute([listing([GIGABYTE - 1])])
        self.execute([listing([GIGABYTE + 3])])
        self.assertEqual(len(self.emails()), 2)
        first, second = self.emails()
        self.assertNotEqual(first.get_header('Idempotency-key'), second.get_header('Idempotency-key'))
        message = json.loads(first.data)
        self.assertEqual(message['to'], ['owner@example.com'])
        self.assertIn('1 GB', message['subject'])
        self.assertIn('1,000,000,001', message['text'])

    def test_failed_listing_preserves_last_measurement_and_warning(self):
        self.execute([listing([GIGABYTE + 1])])
        state = self.state()
        for response in [URLError('fixture-secret'), b'<bad xml',
                         listing([-1]),
                         b'<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>']:
            with self.subTest(response=response):
                code, _, errors = self.execute([response])
                self.assertNotEqual(code, 0)
                self.assertNotIn('fixture-secret', errors)
                self.assertEqual(self.state(), state)
        self.execute([listing([GIGABYTE + 2])])
        self.assertEqual(len(self.emails()), 1)

    def test_repeated_cursor_fails_without_publishing_partial_size(self):
        code, _, _ = self.execute([listing([1], token='same'), listing([2], token='same')])
        self.assertNotEqual(code, 0)
        self.assertFalse((self.directory / 'size.json').exists())

    def test_delivery_retry_keeps_same_payload_and_key_across_processes(self):
        code, _, errors = self.execute([listing([GIGABYTE + 1])], mail=URLError('lost response'))
        self.assertNotEqual(code, 0)
        self.assertIn('backup', errors.lower())
        self.assertEqual(self.state()['bytes'], GIGABYTE + 1)
        self.now += 300
        code, _, errors = self.execute([listing([2 * GIGABYTE])])
        self.assertEqual(code, 0, errors)
        self.assertEqual({req.data for req in self.emails()}, {self.emails()[0].data})
        self.assertEqual(len({req.get_header('Idempotency-key') for req in self.emails()}), 1)
        count = len(self.emails())
        self.execute([listing([3 * GIGABYTE])])
        self.assertEqual(len(self.emails()), count)

    def test_next_timer_run_retries_a_transient_send_failure(self):
        code, _, _ = self.execute([listing([GIGABYTE + 1])], mail=URLError('lost response'))
        self.assertNotEqual(code, 0)
        self.now += longest_timer_gap('screenr-backup-size.timer')
        code, output, errors = self.execute([listing([GIGABYTE + 1])])
        self.assertEqual(code, 0, errors)
        self.assertIn('accepted by Resend', output)
        self.assertEqual(self.state()['warning']['email_id'], 'email-accepted')
        self.assertEqual(len({req.get_header('Idempotency-key') for req in self.emails()}), 1)

    def test_ambiguous_delivery_does_not_resend_after_provider_window(self):
        self.execute([listing([GIGABYTE + 1])], mail=URLError('lost response'))
        count = len(self.emails())
        self.now += 24 * 3600
        code, _, errors = self.execute([listing([2 * GIGABYTE])])
        self.assertNotEqual(code, 0)
        self.assertIn('reconcile', errors.lower())
        self.assertEqual(len(self.emails()), count)

    def test_rejected_email_can_retry_next_day_after_configuration_fix(self):
        rejection = HTTPError('https://api.resend.com/emails', 403, 'secret', {}, None)
        code, _, errors = self.execute([listing([GIGABYTE + 1])], mail=rejection)
        self.assertNotEqual(code, 0)
        self.assertNotIn('secret', errors)
        self.now += 25 * 3600
        code, _, errors = self.execute([listing([2 * GIGABYTE])])
        self.assertEqual(code, 0, errors)

    def test_missing_mail_configuration_is_visible_even_below_threshold(self):
        del self.environment['RESEND_API_KEY']
        code, _, errors = self.execute([listing([100])])
        self.assertNotEqual(code, 0)
        self.assertIn('RESEND_API_KEY', errors)
        self.assertEqual(len(self.requests), 0)

    def test_accepted_email_survives_failure_to_save_its_receipt(self):
        replace = os.replace

        def disk_failure(source, destination):
            warning = json.loads(Path(source).read_text()).get('warning')
            if warning and warning['sent_at'] is not None:
                raise OSError('disk failure after email acceptance')
            return replace(source, destination)

        with patch('os.replace', disk_failure):
            code, _, _ = self.execute([listing([GIGABYTE + 1])])
        self.assertNotEqual(code, 0)
        self.assertIsNone(self.state()['warning']['sent_at'])
        self.now += 60
        code, _, errors = self.execute([listing([GIGABYTE + 2])])
        self.assertEqual(code, 0, errors)
        self.assertEqual(len(self.emails()), 2)
        self.assertEqual(self.emails()[0].data, self.emails()[1].data)
        self.assertEqual(self.emails()[0].get_header('Idempotency-key'),
                         self.emails()[1].get_header('Idempotency-key'))

    def test_invalid_receipt_remains_pending(self):
        for response in [b'{}', b'[]', b'not json']:
            with self.subTest(response=response):
                code, _, _ = self.execute([listing([GIGABYTE + 1])], mail=response)
                self.assertNotEqual(code, 0)
                self.assertIsNone(self.state()['warning']['sent_at'])

    def test_concurrent_monitor_cannot_measure_or_send(self):
        with (self.directory / 'size.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, _, _ = self.execute([listing([GIGABYTE + 1])])
        self.assertNotEqual(code, 0)
        self.assertEqual(len(self.requests), 0)


class BackupJobTests(unittest.TestCase):
    def execute(self, failure='none'):
        # External commands are the boundary. The actual backup script runs.
        wrapper = '''
pg_dump() { echo dump; [ "$failure" != dump ]; }
restic() { echo "restic $*"; [ "$1" != "$failure" ]; }
sleep() { echo "sleep $*"; }
python3() { echo "monitor $*"; [ "$failure" != monitor ]; }
rm() { echo cleanup; }
script=$1
failure=$2
. "$script"
'''
        return subprocess.run(['sh', '-c', wrapper, 'backup-fixture',
                               str(ROOT / 'ops/backup.sh'), failure],
                              text=True, capture_output=True, timeout=5)

    def test_backup_succeeds_without_the_size_monitor(self):
        # A failing or pending warning cannot fail the backup that deploys require.
        result = self.execute('monitor')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('restic backup', result.stdout)
        self.assertIn('--keep-daily 7 --keep-weekly 4 --prune', result.stdout)
        self.assertNotIn('monitor', result.stdout)
        self.assertTrue(result.stdout.rstrip().endswith('cleanup'))

    def test_failed_backup_steps_fail_the_job_and_clean_the_dump(self):
        for failure in ['dump', 'backup', 'forget']:
            with self.subTest(failure=failure):
                result = self.execute(failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('cleanup', result.stdout)


class BackupSizeUnitTests(unittest.TestCase):
    def test_size_monitor_runs_as_its_own_alerting_unit(self):
        unit = unit_file('screenr-backup-size.service')
        self.assertEqual(unit['Unit']['OnFailure'], ['screenr-alert@%n.service'])
        # A run that starts during a backup waits, so it never measures mid-upload.
        self.assertIn('screenr-backup.service', ' '.join(unit['Unit']['After']).split())
        service = unit['Service']
        self.assertEqual(service['Type'], ['oneshot'])
        self.assertEqual(service['ExecStart'],
                         ['/usr/bin/python3 /opt/screenr/current/ops/check-backup-size.py'])
        self.assertEqual(service['User'], ['screenr-db'])
        self.assertEqual(service['EnvironmentFile'], ['/etc/screenr/backup.env'])
        self.assertEqual(service['StateDirectory'], ['screenr-backup'])
        self.assertEqual(service['ProtectSystem'], ['strict'])
        timer = unit_file('screenr-backup-size.timer')
        self.assertEqual(timer['Timer']['Persistent'], ['true'])
        self.assertEqual(timer['Install']['WantedBy'], ['timers.target'])

    def test_deploy_backup_neither_runs_nor_waits_for_the_size_monitor(self):
        # Deployment starts screenr-backup.service, which runs only backup.sh.
        self.assertIn('systemctl start screenr-backup.service',
                      (ROOT / 'ops/deploy-release.sh').read_text())
        backup = unit_file('screenr-backup.service')
        self.assertEqual(backup['Service']['ExecStart'],
                         ['/bin/sh /opt/screenr/current/ops/backup.sh'])
        for name in ['ops/screenr-backup.service', 'ops/backup.sh', 'ops/deploy-release.sh']:
            with self.subTest(file=name):
                self.assertNotIn('backup-size', (ROOT / name).read_text())


if __name__ == '__main__':
    unittest.main()
