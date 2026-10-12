"""Exercise the backup, backup age check, and weekly restore check with fake restic and PostgreSQL."""
import datetime
import io
import json
import os
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
AGE_CHECK = ROOT / 'ops/check-backup-age.py'
HOUR = 3600
NOW = 1_790_000_000


def restic_time(timestamp, offset_hours=0):
    zone = datetime.timezone(datetime.timedelta(hours=offset_hours))
    value = datetime.datetime.fromtimestamp(int(timestamp), zone).isoformat()
    # restic writes Go RFC 3339 times with nanoseconds and Z for UTC.
    value = value[:19] + '.123456789' + value[19:]
    return value.replace('+00:00', 'Z')


def snapshots(*ages):
    return json.dumps([{'time': restic_time(NOW - age), 'short_id': f'snap{index}',
                        'hostname': 'bishop', 'tags': ['screenr']}
                       for index, age in enumerate(ages)])


class BackupAgeTests(unittest.TestCase):
    def execute(self, output):
        calls = []

        def run(command, **options):
            calls.append(command)
            if isinstance(output, BaseException):
                raise output
            return subprocess.CompletedProcess(command, 0, stdout=output)

        stdout, stderr = io.StringIO(), io.StringIO()
        with patch('subprocess.run', run), patch('time.time', return_value=NOW), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            try:
                runpy.run_path(str(AGE_CHECK), run_name='__main__')
            except SystemExit as result:
                code = result.code or 0
            else:
                code = 0
        return code, stdout.getvalue(), stderr.getvalue(), calls

    def test_accepts_newest_snapshot_up_to_30_hours_old(self):
        code, output, errors, calls = self.execute(snapshots(30 * HOUR))
        self.assertEqual(code, 0, errors)
        self.assertIn('snap0', output)
        self.assertIn('30.0 hours old', output)
        self.assertEqual([list(command) for command in calls],
                         [['restic', 'snapshots', '--no-lock', '--host', 'bishop',
                           '--tag', 'screenr', '--latest', '1', '--json']])

    def test_fails_when_newest_snapshot_is_older_than_30_hours(self):
        code, output, errors, _ = self.execute(snapshots(30 * HOUR + 1))
        self.assertEqual(code, 1)
        self.assertEqual(output, '')
        self.assertIn('snap0', errors)
        self.assertIn('30-hour limit', errors)

    def test_uses_the_newest_snapshot_in_any_time_zone(self):
        stale, fresh = NOW - 50 * HOUR, NOW - 2 * HOUR
        output = json.dumps([{'time': restic_time(stale), 'short_id': 'old'},
                             {'time': restic_time(fresh, offset_hours=-7), 'short_id': 'new'}])
        code, output, errors, _ = self.execute(output)
        self.assertEqual(code, 0, errors)
        self.assertIn('new is 2.0 hours old', output)

    def test_fails_without_a_readable_snapshot(self):
        for output in ['[]', 'null', '{}', 'not json', '[{}]', '[{"time": "yesterday"}]',
                       '[{"time": 1790000000}]', '["2026-10-12T19:51:52Z"]']:
            with self.subTest(output=output):
                code, stdout, errors, _ = self.execute(output)
                self.assertEqual(code, 1)
                self.assertEqual(stdout, '')
                self.assertIn('Backup age check failed', errors)

    def test_fails_when_restic_cannot_list_snapshots(self):
        for error in [subprocess.CalledProcessError(1, 'restic'), FileNotFoundError('restic'),
                      subprocess.TimeoutExpired('restic', 300)]:
            with self.subTest(error=type(error).__name__):
                code, output, errors, _ = self.execute(error)
                self.assertEqual(code, 1)
                self.assertEqual(output, '')
                self.assertIn('Backup age check failed', errors)


class BackupScriptTests(unittest.TestCase):
    DUMP = '/var/lib/screenr-backup/screenr.dump'

    def execute(self, dump=':'):
        # External commands are the boundary; ops/backup.sh runs unchanged.
        wrapper = '''
pg_dump() { echo "pg_dump"; eval "$DUMP"; }
restic() { echo "restic $1"; }
rm() { echo "rm $*"; }
. "$SCRIPT"
'''
        environment = {**os.environ, 'SCRIPT': str(ROOT / 'ops/backup.sh'), 'DUMP': dump}
        return subprocess.run(['sh', '-c', wrapper], text=True, capture_output=True,
                              env=environment, timeout=10)

    def test_backup_uploads_prunes_and_removes_the_dump(self):
        result = self.execute()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(),
                         ['pg_dump', 'restic backup', 'restic forget', f'rm -f {self.DUMP}'])

    def test_stopped_backup_fails_and_removes_the_dump_once(self):
        # The signal can arrive while a command that still succeeds runs. The
        # script must stop there instead of uploading or pruning.
        for signal in ('HUP', 'INT', 'TERM'):
            with self.subTest(signal=signal):
                result = self.execute(f'kill -{signal} $$')
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout.splitlines(), ['pg_dump', f'rm -f {self.DUMP}'])


class RestoreCheckTests(unittest.TestCase):
    def execute(self, *, age, profiles='3', restore=':'):
        # External commands are the boundary. The restore and age check scripts run.
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        base = Path(directory.name)
        (base / 'bin').mkdir()
        restic = base / 'bin/restic'
        restic.write_text('#!/bin/sh\nprintf \'%s\\n\' "$SNAPSHOTS"\n')
        restic.chmod(0o755)
        newest = time.time() - age
        stamp = datetime.datetime.fromtimestamp(newest, datetime.timezone.utc)
        wrapper = '''
python3() {
    [ "$1" = /opt/screenr/current/ops/check-backup-age.py ] || return 97
    PATH="$FIXTURE/bin:$PATH" "$PYTHON" "$AGE_CHECK"
}
restic() { echo "restic $1"; }
mktemp() { echo "$FIXTURE/restore.dump"; }
createdb() { echo "createdb $*"; }
dropdb() { echo "dropdb $*"; }
pg_restore() { eval "$RESTORE"; }
psql() {
    case "$*" in *'SELECT count(*) FROM profile'*) echo "$PROFILES" ;; esac
}
. "$SCRIPT"
'''
        environment = {**os.environ, 'FIXTURE': str(base), 'PYTHON': sys.executable,
                       'AGE_CHECK': str(AGE_CHECK), 'SCRIPT': str(ROOT / 'ops/restore-check.sh'),
                       'PROFILES': profiles, 'RESTORE': restore,
                       'SNAPSHOTS': json.dumps([{'time': stamp.isoformat().replace('+00:00', 'Z'),
                                                 'short_id': 'fixture'}])}
        return subprocess.run(['sh', '-c', wrapper], text=True, capture_output=True,
                              env=environment, timeout=10)

    def temporary_databases(self, output, command):
        return [line.split()[-1] for line in output.splitlines() if line.startswith(command + ' ')]

    def test_fresh_backup_with_profiles_passes_and_drops_temporary_database(self):
        result = self.execute(age=2 * HOUR)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Newest Screenr backup fixture is 2.0 hours old', result.stdout)
        self.assertIn('restore passed', result.stdout)
        created = self.temporary_databases(result.stdout, 'createdb')
        self.assertEqual(len(created), 1)
        self.assertEqual(self.temporary_databases(result.stdout, 'dropdb'), created)

    def test_stale_backup_fails_without_restoring(self):
        result = self.execute(age=31 * HOUR)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('30-hour limit', result.stderr)
        self.assertNotIn('restore passed', result.stdout)
        self.assertEqual(self.temporary_databases(result.stdout, 'createdb'), [])

    def test_restore_without_profiles_fails_and_drops_temporary_database(self):
        for profiles in ['0', '', 'not a count']:
            with self.subTest(profiles=profiles):
                result = self.execute(age=HOUR, profiles=profiles)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('no restored profiles', result.stderr)
                self.assertNotIn('restore passed', result.stdout)
                created = self.temporary_databases(result.stdout, 'createdb')
                self.assertEqual(len(created), 1)
                self.assertEqual(self.temporary_databases(result.stdout, 'dropdb'), created)

    def test_stopped_restore_fails_and_drops_temporary_database_once(self):
        # A timeout makes systemd send SIGTERM to the script and to pg_restore,
        # whose server connection can outlive it briefly.
        result = self.execute(age=HOUR, restore='kill -TERM $$; return 143')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('restore passed', result.stdout)
        created = self.temporary_databases(result.stdout, 'createdb')
        self.assertEqual(len(created), 1)
        self.assertEqual(self.temporary_databases(result.stdout, 'dropdb'), created)
        self.assertIn('dropdb --force ' + created[0], result.stdout)


if __name__ == '__main__':
    unittest.main()
