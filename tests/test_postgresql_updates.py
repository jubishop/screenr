"""Exercise the PostgreSQL updater against a fake host: apt, systemctl, psql, Screenr's API, and a clock."""
import contextlib
import datetime
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import URLError

from test_failure_alert import daily_utc_seconds, unit_file

ROOT = Path(__file__).resolve().parents[1]
UPDATER = ROOT / 'ops/update-postgresql.py'
# A daily run around 10:05 UTC on the day a PostgreSQL minor release appears.
RELEASE_DAY = datetime.datetime(2026, 11, 12, 10, 5, tzinfo=datetime.timezone.utc).timestamp()
DAY = 86400
UBUNTU = ('Listing...\n'
          'alsa-ucm-conf/noble-updates 1.2.10-1ubuntu5.15 all [upgradable from: 1.2.10-1ubuntu5.13]\n'
          'libkrb5-3/noble-updates,noble-security 1.20.1-6ubuntu2.10 amd64 '
          '[upgradable from: 1.20.1-6ubuntu2.7]\n')
SERVER = 'postgresql-18/noble-pgdg 18.7-1.pgdg24.04+1 amd64 [upgradable from: 18.6-1.pgdg24.04+2]\n'
LIBRARY = 'libpq5/noble-pgdg 18.7-1.pgdg24.04+1 amd64 [upgradable from: 18.6-1.pgdg24.04+2]\n'
COMMON = 'postgresql-common/noble-pgdg 295.pgdg24.04+1 all [upgradable from: 293.pgdg24.04+1]\n'
RELEASE = UBUNTU + LIBRARY + SERVER
PLAN = ('Inst libpq5 [18.6-1.pgdg24.04+2] (18.7-1.pgdg24.04+1 PostgreSQL for Debian:noble-pgdg [amd64])\n'
        'Conf libpq5 (18.7-1.pgdg24.04+1 PostgreSQL for Debian:noble-pgdg [amd64])\n')


def load_updater():
    spec = importlib.util.spec_from_file_location('update_postgresql', UPDATER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeHost:
    """Answers the updater's commands and API requests, and records them in order."""

    def __init__(self, lock):
        self.lock = lock
        self.listing = RELEASE
        self.plan = PLAN
        self.failures = {}  # step -> (status, output) or an exception
        self.healthy = True
        self.unhealthy_after = None  # a step after which Screenr stops answering
        self.restarting = False
        self.version = '18.7 (Ubuntu 18.7-1.pgdg24.04+1)'
        self.steps, self.commands, self.urls = [], [], []
        self.environments = {}
        self.locked_during = set()
        self.restarts = 0

    def step(self, command):
        if command[0] == 'apt':
            return 'list'
        if command[0] == 'apt-get':
            return ('simulate' if '--simulate' in command else
                    'download' if '--download-only' in command else 'install')
        if command[:2] == ('systemctl', 'start'):
            return 'backup'
        if command[:2] == ('systemctl', 'restart'):
            return 'restart'
        if command[:2] == ('systemctl', 'is-active'):
            return 'is-active'
        if command[:2] == ('systemctl', 'show'):
            return 'show'
        if command[0] == 'runuser':
            return 'reindex' if command[-1].startswith('REINDEX') else 'version'
        raise AssertionError(f'Unexpected command {command}')

    def run(self, command, **options):
        command = tuple(command)
        step = self.step(command)
        if step not in ('is-active', 'show'):
            self.steps.append(step)
            self.environments[step] = options.get('env')
            with self.lock.open('a') as probe:
                try:
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.flock(probe, fcntl.LOCK_UN)
                except BlockingIOError:
                    self.locked_during.add(step)
        self.commands.append(command)
        failure = self.failures.get(step)
        if isinstance(failure, BaseException):
            raise failure
        status, output = failure or (0, {
            'list': self.listing, 'simulate': self.plan, 'version': self.version + '\n',
            'show': f'Id=screenr-web.service\nNRestarts={self.restarts}\n',
            'is-active': '', 'install': 'Setting up postgresql-18 (18.7-1.pgdg24.04+1) ...\n',
        }.get(step, ''))
        if step == 'is-active' and not self.answering():
            status = 3
        if step == 'show' and self.restarting:
            self.restarts += 1
        if step == 'install' and not status:
            self.listing = UBUNTU
        if self.unhealthy_after == step:
            self.healthy = False
        if options.get('check') and status:
            raise subprocess.CalledProcessError(status, command, output)
        return subprocess.CompletedProcess(command, status, stdout=output)

    def answering(self):
        return self.healthy

    def urlopen(self, url, timeout):
        assert timeout > 0
        self.urls.append(url)
        if not self.answering():
            raise URLError('connection refused')
        return io.BytesIO(b'null' if url.endswith('auth/get-session') else b'{"ok":true}')


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        self.state = self.base / 'screenr-postgresql-updates'
        self.lock = self.base / 'deploy.lock'
        self.updater = load_updater()
        self.host = FakeHost(self.lock)
        self.monotonic = 0.0

    def sleep(self, seconds):
        self.monotonic += seconds

    def execute(self, day, *arguments):
        """Run the updater on a day after RELEASE_DAY and return its exit status and output."""
        self.host.commands, self.host.urls, self.host.steps = [], [], []
        output, errors = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {'STATE_DIRECTORY': str(self.state)}, clear=True), \
                patch('sys.argv', [str(UPDATER), *arguments]), \
                patch.object(self.updater, 'DEPLOY_LOCK', self.lock), \
                patch('subprocess.run', self.host.run), patch('urllib.request.urlopen', self.host.urlopen), \
                patch('time.time', return_value=RELEASE_DAY + day * DAY), \
                patch('time.monotonic', lambda: self.monotonic), patch('time.sleep', self.sleep), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
            code = self.updater.main()
        return code, output.getvalue(), errors.getvalue()

    def status(self):
        return json.loads((self.state / 'status.json').read_text())

    def run_days(self, days):
        for day in days:
            code, _, errors = self.execute(day)
            self.assertEqual(code, 0, errors)
        return self.status()

    def test_waits_seven_days_then_installs_under_the_deploy_lock(self):
        for day in range(7):
            code, output, errors = self.execute(day)
            self.assertEqual(code, 0, errors)
            self.assertIn('postgresql-18 18.6-1.pgdg24.04+2 -> 18.7-1.pgdg24.04+1, first seen 2026-11-12', output)
            self.assertEqual(self.host.steps, ['list'], f'day {day}')
            status = self.status()
            self.assertEqual(status['result'], 'current')
            self.assertIn('Waiting until 2026-11-19 to install libpq5 18.6-1.pgdg24.04+2 -> 18.7-1.pgdg24.04+1, '
                          'postgresql-18 18.6-1.pgdg24.04+2 -> 18.7-1.pgdg24.04+1.', status['message'])
            self.assertEqual(status['last_success'], status['checked'])
        code, output, errors = self.execute(7)
        self.assertEqual(code, 0, errors)
        self.assertEqual(self.host.steps, ['list', 'simulate', 'download', 'backup', 'install', 'restart',
                                           'version', 'reindex'])
        # Everything from the download to the reindex holds the deploy lock.
        self.assertEqual(self.host.locked_during, {'download', 'backup', 'install', 'restart', 'version',
                                                   'reindex'})
        install = next(command for command in self.host.commands if self.host.step(command) == 'install')
        self.assertEqual(install[-3:], ('--only-upgrade', 'libpq5', 'postgresql-18'))
        self.assertIn('Dpkg::Options::=--force-confold', install)
        self.assertIn('DPkg::Lock::Timeout=600', install)
        self.assertEqual(self.host.environments['install'], {
            'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C',
            'DEBIAN_FRONTEND': 'noninteractive', 'NEEDRESTART_MODE': 'l'})
        self.assertIn(('systemctl', 'start', 'screenr-backup.service'), self.host.commands)
        self.assertIn(('systemctl', 'restart', 'screenr-db.service'), self.host.commands)
        self.assertEqual(self.host.commands[-1][-1], 'REINDEX DATABASE screenr')
        self.assertEqual(self.host.commands[-1][:4], ('runuser', '-u', 'screenr-db', '--'))
        # Activation's health check: the API, a signed-out session, then stable units.
        self.assertIn('http://127.0.0.1:3060/api/health', self.host.urls)
        self.assertIn('http://127.0.0.1:3060/api/auth/get-session', self.host.urls)
        status = self.status()
        self.assertEqual(status['result'], 'updated')
        self.assertEqual(status['message'], 'Installed libpq5 18.6-1.pgdg24.04+2 -> 18.7-1.pgdg24.04+1, '
                                            'postgresql-18 18.6-1.pgdg24.04+2 -> 18.7-1.pgdg24.04+1.')
        self.assertEqual(status['pending'], {})
        self.assertIsNone(status['trouble_since'])
        self.assertEqual(status['last_success'], '2026-11-19T10:05:00+00:00')
        self.assertEqual(oct((self.state / 'status.json').stat().st_mode & 0o777), '0o644')
        status = self.run_days([8])
        self.assertEqual((status['result'], status['message']), ('current', 'No PostgreSQL updates pending.'))
        self.assertEqual(self.host.steps, ['list'])

    def test_only_postgresql_repository_updates_count(self):
        self.host.listing = UBUNTU
        status = self.run_days([0, 7, 30])
        self.assertEqual((status['result'], status['message']), ('current', 'No PostgreSQL updates pending.'))
        self.assertEqual(status['pending'], {})
        self.assertEqual(self.host.steps, ['list'])

    def test_a_newer_version_starts_its_own_wait(self):
        self.run_days([0, 3])
        self.host.listing = RELEASE.replace('18.7-1.pgdg24.04+1', '18.8-1.pgdg24.04+1')
        status = self.run_days([4, 10])
        self.assertEqual(status['result'], 'current')
        self.assertIn('Waiting until 2026-11-23', status['message'])
        self.assertEqual({entry['since'] for entry in status['pending'].values()}, {'2026-11-16'})
        self.host.version = '18.8 (Ubuntu 18.8-1.pgdg24.04+1)'
        self.assertEqual(self.run_days([11])['result'], 'updated')

    def test_packages_seen_on_different_days_install_together_once_the_first_is_due(self):
        self.host.listing = UBUNTU + LIBRARY
        self.run_days([0])
        self.host.listing = RELEASE + COMMON
        status = self.run_days([1, 6])
        self.assertEqual(status['pending']['libpq5 18.7-1.pgdg24.04+1']['since'], '2026-11-12')
        self.assertEqual(status['pending']['postgresql-18 18.7-1.pgdg24.04+1']['since'], '2026-11-13')
        status = self.run_days([7])
        self.assertEqual(status['result'], 'updated')
        install = next(command for command in self.host.commands if self.host.step(command) == 'install')
        self.assertEqual(install[-4:], ('--only-upgrade', 'libpq5', 'postgresql-18', 'postgresql-common'))

    def test_client_only_update_checks_health_without_restarting_or_reindexing(self):
        self.host.listing = UBUNTU + LIBRARY + COMMON
        status = self.run_days([0, 7])
        self.assertEqual(status['result'], 'updated')
        self.assertEqual(self.host.steps, ['list', 'simulate', 'download', 'backup', 'install'])
        self.assertIn('http://127.0.0.1:3060/api/health', self.host.urls)

    def test_a_planned_removal_retries_then_blocks_without_touching_screenr(self):
        self.host.plan = PLAN + 'Remv postgresql-contrib [18.6-1.pgdg24.04+2]\n'
        self.run_days([0])
        for day, result in ((7, 'retrying'), (8, 'retrying'), (9, 'retrying'), (10, 'blocked'), (11, 'blocked')):
            status = self.run_days([day])
            self.assertEqual(status['result'], result, f'day {day}')
            self.assertEqual(status['trouble_since'], '2026-11-19')
            self.assertEqual(self.host.steps, ['list', 'simulate'])
            self.assertIn('Upgrading would remove postgresql-contrib, so it needs a person.', status['message'])
            self.assertIn('Retrying daily since 2026-11-19.', status['message'])
            # Retrying is no success, so last_success still names the day-0 run.
            self.assertEqual(status['last_success'], '2026-11-12T10:05:00+00:00')
        self.host.plan = PLAN
        status = self.run_days([12])
        self.assertEqual((status['result'], status['trouble_since']), ('updated', None))

    def test_a_held_deploy_lock_retries_the_next_day(self):
        self.run_days([0])
        with self.lock.open('a') as deployment:
            fcntl.flock(deployment, fcntl.LOCK_EX)
            status = self.run_days([7])
        self.assertEqual(status['result'], 'retrying')
        self.assertIn('held', status['message'])
        self.assertIn('for 30 minutes', status['message'])
        self.assertEqual(self.host.steps, ['list', 'simulate'])
        self.assertGreaterEqual(self.monotonic, 30 * 60)
        self.assertEqual(self.run_days([8])['result'], 'updated')

    def test_a_failed_download_or_backup_retries_without_installing(self):
        for step in ('download', 'backup'):
            with self.subTest(step=step):
                self.setUp()
                self.run_days([0])
                self.host.failures[step] = (1, 'E: Failed to fetch https://apt.postgresql.org/x.deb  404\n')
                status = self.run_days([7])
                self.assertEqual(status['result'], 'retrying')
                self.assertNotIn('install', self.host.steps)
                self.assertIn('Could not prepare the upgrade:', status['message'])
                self.assertIn('exited with status 1', status['message'])

    def test_unreadable_updates_retry_then_block(self):
        failures = [subprocess.CalledProcessError(100, ('apt',)), FileNotFoundError('apt'),
                    'Listing...\nE: something unexpected\n', 'postgresql-18/noble-pgdg 18.7-1.pgdg24.04+1 amd64\n']
        for failure in failures:
            with self.subTest(failure=failure):
                self.setUp()
                if isinstance(failure, str):
                    self.host.listing = failure
                else:
                    self.host.failures['list'] = failure
                self.assertEqual(self.run_days([0, 1, 2])['result'], 'retrying')
                status = self.run_days([3])
                self.assertEqual(status['result'], 'blocked')
                self.assertIn('Could not list pending updates', status['message'])
                self.assertEqual(self.host.steps, ['list'])

    def test_an_upgrade_that_goes_wrong_while_screenr_stays_healthy_blocks_at_once(self):
        cases = {
            'install': ((100, 'E: Sub-process /usr/bin/dpkg returned an error code (1)\n'),
                        'Could not install the packages: apt-get exited with status 100: E: Sub-process'),
            'version': (None, "Could not confirm the new server version: PostgreSQL reports version "
                              "'18.6 (Ubuntu 18.6-1.pgdg24.04+2)', not 18.7."),
            'reindex': ((3, 'ERROR:  could not create unique index "users_email_key"\n'
                            'DETAIL:  Key (email)=(member@example.com) is duplicated.\n'),
                        'Could not reindex the database: runuser exited with status 3. Screenr'),
        }
        for step, (failure, message) in cases.items():
            with self.subTest(step=step):
                self.setUp()
                self.run_days([0])
                if step == 'version':
                    self.host.version = '18.6 (Ubuntu 18.6-1.pgdg24.04+2)'
                else:
                    self.host.failures[step] = failure
                code, _, errors = self.execute(7)
                self.assertEqual(code, 0, errors)
                status = self.status()
                self.assertEqual(status['result'], 'blocked')
                self.assertIn(message, status['message'])
                self.assertTrue(status['message'].endswith('Screenr is still healthy.'))
                # Only apt's output reaches the status, which a public issue may quote.
                self.assertNotIn('member@example.com', json.dumps(status))
                self.assertEqual(status['trouble_since'], '2026-11-19')

    def test_unhealthy_screenr_after_the_upgrade_fails_the_unit(self):
        for step in ('install', 'restart'):
            with self.subTest(step=step):
                self.setUp()
                self.run_days([0])
                self.host.unhealthy_after = step
                code, output, errors = self.execute(7)
                self.assertEqual(code, 1)
                status = self.status()
                self.assertEqual(status['result'], 'failed')
                self.assertIn('Could not confirm that Screenr is healthy', status['message'])
                self.assertIn('Screenr is unhealthy', status['message'])
                self.assertNotIn('reindex', self.host.steps)
                self.assertIn('PostgreSQL update failed', output)

    def test_a_service_that_keeps_restarting_fails_the_unit(self):
        self.run_days([0])
        self.host.restarting = True
        code, _, _ = self.execute(7)
        self.assertEqual(code, 1)
        self.assertIn('stopped or restarted within 15 seconds', self.status()['message'])

    def test_dry_run_reports_without_installing_or_saving(self):
        code, output, errors = self.execute(0, '--dry-run')
        self.assertEqual(code, 0, errors)
        self.assertIn('Waiting until 2026-11-19', output)
        self.assertFalse(self.state.exists())
        self.run_days([0])
        before = self.status()
        code, output, errors = self.execute(7, '--dry-run')
        self.assertEqual(code, 0, errors)
        self.assertIn('Dry run; would install libpq5 18.6-1.pgdg24.04+2 -> 18.7-1.pgdg24.04+1', output)
        self.assertEqual(self.host.steps, ['list'])
        self.assertEqual(self.status(), before)

    def test_unreadable_saved_status_restarts_the_wait(self):
        self.state.mkdir()
        for content in ['not json', '[]', '{"pending": {"libpq5 18.7": {"since": "soon"}}}']:
            with self.subTest(content=content):
                (self.state / 'status.json').write_text(content)
                code, _, errors = self.execute(7)
                self.assertEqual(code, 0, errors)
                self.assertIn('Ignoring unreadable saved status', errors)
                status = self.status()
                self.assertEqual(status['result'], 'current')
                self.assertIn('Waiting until 2026-11-26', status['message'])

    def test_reads_apt_lists_without_changing_packages(self):
        self.execute(0)
        self.assertEqual(self.host.commands, [('apt', '-o', 'Apt::Cmd::Disable-Script-Warning=true',
                                               'list', '--upgradable')])
        self.assertEqual(self.host.environments['list'], {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})


class UpdaterUnitTests(unittest.TestCase):
    def test_daily_unit_runs_the_kit_script_as_root_and_alerts_on_failure(self):
        unit = unit_file('screenr-postgresql-updates.service')
        self.assertEqual(unit['Unit']['OnFailure'], ['screenr-alert@%n.service'])
        service = unit['Service']
        self.assertEqual(service['Type'], ['oneshot'])
        self.assertEqual(service['ExecStart'],
                         ['/usr/bin/python3 -I /usr/local/lib/screenr-deploy/update-postgresql.py'])
        # apt and dpkg need root, so the unit sets neither a user nor a sandbox.
        for key in ('User', 'DynamicUser', 'ProtectSystem', 'NoNewPrivileges', 'CapabilityBoundingSet'):
            self.assertNotIn(key, service)
        self.assertEqual(service['StateDirectory'], ['screenr-postgresql-updates'])
        self.assertIn('/var/lib/screenr-postgresql-updates/status.json',
                      (ROOT / 'ops/receive-release').read_text())

    def test_timer_runs_daily_before_the_backup(self):
        timer = unit_file('screenr-postgresql-updates.timer')
        self.assertEqual(timer['Timer']['Persistent'], ['true'])
        self.assertEqual(timer['Install']['WantedBy'], ['timers.target'])
        update = daily_utc_seconds('screenr-postgresql-updates.timer')
        self.assertEqual(update, 10 * 3600)
        self.assertLess(update + 3600, daily_utc_seconds('screenr-backup.timer'))


if __name__ == '__main__':
    unittest.main()
