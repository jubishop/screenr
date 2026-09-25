"""Exercise the backup monitor CLI with HTTP fakes and real persisted state."""
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

ROOT = Path(__file__).resolve().parents[1]
GIGABYTE = 1_000_000_000


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
python3() { echo "monitor $*"; [ "$failure" != monitor ]; }
rm() { echo cleanup; }
script=$1
failure=$2
. "$script"
'''
        return subprocess.run(['sh', '-c', wrapper, 'backup-fixture',
                               str(ROOT / 'ops/backup.sh'), failure],
                              text=True, capture_output=True, timeout=5)

    def test_monitor_runs_only_after_successful_backup_and_prune(self):
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--keep-daily 7 --keep-weekly 4 --prune', result.stdout)
        self.assertIn('check-backup-size.py', result.stdout)
        self.assertLess(result.stdout.index('restic forget'), result.stdout.index('monitor'))
        for failure in ['dump', 'backup', 'forget']:
            result = self.execute(failure)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('monitor', result.stdout)
            self.assertIn('cleanup', result.stdout)

    def test_monitor_failure_does_not_undo_backup_and_cleans_dump(self):
        result = self.execute('monitor')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('restic backup', result.stdout)
        self.assertTrue(result.stdout.rstrip().endswith('cleanup'))


if __name__ == '__main__':
    unittest.main()
