"""Exercise the crash check with a fake systemctl and journalctl, and check its units."""
import io
import os
from pathlib import Path
import re
import runpy
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from test_failure_alert import unit_file
from test_memory_check import NOW, FakeHost, entry, long_running_services, systemd

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / 'ops/check-crashes.py'
SERVICES = ('screenr-web.service', 'screenr-worker.service', 'screenr-db.service')
MINUTE = 60
HOUR = 3600
# systemd 255's journal message IDs for a unit's run, as the host logged them
# on 2026-11-05 and 2026-11-10: a main process that exited, a run that ended
# with a result other than success, the resources a run used, an automatic
# restart, and a job's start, stop, and completion.
EXITED = '98e322203f7a4ed290d09fe03c09fe15'
FAILED = 'd9b373ed55a64feb8242e02dbe79a49c'
SUCCEEDED = '7ad2d189f7e94e70a38c781354912448'
RESOURCES = 'ae8f7b866b0347b9af31fe1c80b127c0'
RESTART = '5eb03494b6584870a536b337290809b3'
STARTED = '39f53479d3a045ac8e11786248231fbf'
STOPPING = 'de5b426a63be47a7b6ac3eaac82e2f6f'
DONE = '9d1aaa27d60140bd96365438aad20286'
START_FAILED = 'be02cf6855d2428ba40df7e9d022f03d'
# What each result's main process exit looks like.
EXITS = {'exit-code': ('exited', '1', 'status=1/FAILURE'), 'signal': ('killed', '6', 'status=6/ABRT'),
         'oom-kill': ('killed', '9', 'status=9/KILL')}


def crash(at, unit, invocation, restarts, result='exit-code', restarted=True):
    """systemd's lines for a run that crashed, then its automatic restart."""
    code, status, text = EXITS[result]
    lines = [
        systemd(at, unit, EXITED, f'Main process exited, code={code}, {text}', EXIT_CODE=code, EXIT_STATUS=status,
                COMMAND='ExecStart', INVOCATION_ID=invocation),
        systemd(at, unit, FAILED, f"Failed with result '{result}'.", UNIT_RESULT=result, INVOCATION_ID=invocation),
        systemd(at, unit, RESOURCES, 'Consumed 1.2s CPU time.', INVOCATION_ID=invocation),
    ]
    if restarted:
        lines += [
            systemd(at + 5, unit, RESTART, f'Scheduled restart job, restart counter is at {restarts}.',
                    N_RESTARTS=str(restarts), INVOCATION_ID=invocation),
            systemd(at + 5, unit, STARTED, f'Started {unit}.', JOB_TYPE='start', JOB_RESULT='done',
                    INVOCATION_ID=f'{invocation}-next'),
        ]
    return lines


def crash_loop(start, unit, every, count, result='exit-code'):
    """A run that crashes every `every` seconds after it starts, restarted 5 seconds later each time."""
    lines = []
    for run in range(count):
        lines += crash(start + run * (every + 5) + every, unit, f'{unit}-run-{run}', run + 1, result)
    return lines


def restart_limit(start, unit, count):
    """Runs that crashed until systemd 255 refused another start: it logs the last run's failure again."""
    lines = crash_loop(start, unit, 1, count)
    last, at = f'{unit}-run-{count - 1}', start + count * 6
    return lines + [
        entry(at, _PID='1', _UID='0', SYSLOG_IDENTIFIER='systemd', UNIT=unit, INVOCATION_ID=last,
              MESSAGE=f'{unit}: Start request repeated too quickly.'),
        systemd(at, unit, FAILED, "Failed with result 'exit-code'.", UNIT_RESULT='exit-code', INVOCATION_ID=last),
        systemd(at, unit, START_FAILED, f'Failed to start {unit}.', JOB_TYPE='start', JOB_RESULT='failed',
                INVOCATION_ID=last),
    ]


def deploy_restart(at, unit, invocation):
    """systemd's lines when deployment restarts a service, which stops cleanly."""
    return [
        systemd(at, unit, STOPPING, f'Stopping {unit}...', JOB_TYPE='stop', INVOCATION_ID=invocation),
        systemd(at, unit, SUCCEEDED, 'Deactivated successfully.', INVOCATION_ID=invocation),
        systemd(at, unit, DONE, f'Stopped {unit}.', JOB_TYPE='restart', JOB_RESULT='done', INVOCATION_ID=invocation),
        systemd(at, unit, RESOURCES, 'Consumed 7.7s CPU time, 53.5M memory peak, 0B memory swap peak.',
                INVOCATION_ID=invocation, MEMORY_PEAK='56098816'),
        systemd(at, unit, STARTED, f'Started {unit}.', JOB_TYPE='start', JOB_RESULT='done',
                INVOCATION_ID=f'{invocation}-next'),
    ]


class CrashHost(FakeHost):
    """The memory check's fake journal, with systemctl show for each service's state and restart count."""

    def __init__(self, entries=(), states=None, **options):
        super().__init__(entries, **options)
        # {unit: (ActiveState, SubState, NRestarts)}; a missing unit is not loaded.
        self.states = {unit: ('active', 'running', 0) for unit in SERVICES} if states is None else states

    def systemctl(self, command, options):
        if command[:2] != ['systemctl', 'show'] or len(command) != 4 or \
                command[3] != '--property=LoadState,ActiveState,SubState,NRestarts':
            raise AssertionError(f'Unexpected systemctl call {command}')
        unit = command[2]
        if unit not in self.states:
            return subprocess.CompletedProcess(command, 0, stdout='LoadState=not-found\nActiveState=inactive\n'
                                                                  'SubState=dead\nNRestarts=0\n')
        active, sub, restarts = self.states[unit]
        return subprocess.CompletedProcess(command, 0, stdout=f'LoadState=loaded\nActiveState={active}\n'
                                                              f'SubState={sub}\nNRestarts={restarts}\n')


class CrashCheckTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.state = Path(directory.name)

    def execute(self, host, *arguments, at=NOW):
        arguments = arguments or SERVICES
        output, errors = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, {'STATE_DIRECTORY': str(self.state)}, clear=True), \
                patch('sys.argv', [str(CHECK), *arguments]), patch('subprocess.run', host.run), \
                patch('time.time', return_value=at), redirect_stdout(output), redirect_stderr(errors):
            try:
                runpy.run_path(str(CHECK), run_name='__main__')
            except SystemExit as result:
                code = result.code or 0
            else:
                code = 0
        return code, output.getvalue(), errors.getvalue()

    def saved(self):
        return sorted(path.name for path in self.state.iterdir())

    def test_a_service_that_crashes_every_10_seconds_alerts_at_the_next_check_and_once_for_the_loop(self):
        # The worker crashes 10 seconds after each start, and systemd restarts
        # it 5 seconds later: 4 starts a minute, under the restart limit of 5
        # in 60 seconds, so systemd never stops it and its failure alert never
        # runs (#576). The timer runs the check every 5 minutes.
        loop = crash_loop(NOW, 'screenr-worker.service', 10, 240)
        states = {**CrashHost().states, 'screenr-worker.service': ('activating', 'auto-restart', 20)}
        code, output, errors = self.execute(CrashHost(loop, states=states), at=NOW)
        self.assertEqual(code, 0, errors)
        code, output, errors = self.execute(CrashHost(loop, states=states), at=NOW + 5 * MINUTE)
        self.assertEqual(code, 1)
        self.assertIn('screenr-worker.service: 20 runs ended unexpectedly, with exit-code, between '
                      '2026-11-05 17:33:30 UTC and 2026-11-05 17:38:15 UTC. systemd has restarted it 20 times '
                      'since it last started by hand, and it is activating (auto-restart).', errors)
        self.assertNotIn('screenr-web.service', errors)
        # The loop goes on, and later checks fold it into that email.
        for minutes in (10, 15, 60):
            with self.subTest(minutes=minutes):
                code, output, errors = self.execute(CrashHost(loop, states=states), at=NOW + minutes * MINUTE)
                self.assertEqual(code, 0, errors)
                self.assertIn('screenr-worker.service: ', output)
                self.assertIn('part of a crash loop already reported', output)

    def test_deploy_restarts_do_not_alert(self):
        # Deployment restarts the web and worker; both stop cleanly, which
        # resets their restart counts, and the database restarts by hand the same way.
        restarts = [*deploy_restart(NOW - 600, 'screenr-web.service', 'web-before'),
                    *deploy_restart(NOW - 600, 'screenr-worker.service', 'worker-before'),
                    *deploy_restart(NOW - 300, 'screenr-db.service', 'db-before')]
        code, output, errors = self.execute(CrashHost(restarts))
        self.assertEqual(code, 0, errors)
        self.assertEqual(errors, '')
        self.assertIn('No Screenr service ended unexpectedly', output)

    def test_a_single_crash_alerts(self):
        for unit, result in [('screenr-web.service', 'signal'), ('screenr-db.service', 'exit-code'),
                             ('screenr-worker.service', 'oom-kill')]:
            with self.subTest(unit=unit):
                for path in self.state.iterdir():
                    path.unlink()
                code, _, errors = self.execute(CrashHost(crash(NOW - 120, unit, 'one', 1, result)))
                self.assertEqual(code, 1)
                self.assertIn(f'{unit}: 1 run ended unexpectedly, with {result}, at ', errors)

    def test_counts_each_result(self):
        lines = [*crash(NOW - 300, 'screenr-web.service', 'a', 1, 'signal'),
                 *crash(NOW - 200, 'screenr-web.service', 'b', 2, 'exit-code'),
                 *crash(NOW - 100, 'screenr-web.service', 'c', 3, 'signal')]
        code, _, errors = self.execute(CrashHost(lines))
        self.assertEqual(code, 1)
        self.assertIn('screenr-web.service: 3 runs ended unexpectedly, with signal 2 times and exit-code once, '
                      'between ', errors)

    def test_a_crash_after_an_hour_without_one_starts_a_new_loop(self):
        unit = 'screenr-worker.service'
        first = crash(NOW - 60, unit, 'first', 1)
        code, _, _ = self.execute(CrashHost(first))
        self.assertEqual(code, 1)
        # Less than an hour after the last crash: the same loop.
        again = crash(NOW + 50 * MINUTE, unit, 'again', 2)
        code, output, errors = self.execute(CrashHost([*first, *again]), at=NOW + 55 * MINUTE)
        self.assertEqual(code, 0, errors)
        self.assertIn('part of a crash loop already reported', output)
        # More than an hour after it: a new loop.
        later = crash(NOW + 50 * MINUTE + HOUR + 1, unit, 'later', 1)
        code, _, errors = self.execute(CrashHost([*first, *again, *later]), at=NOW + 2 * HOUR)
        self.assertEqual(code, 1)
        self.assertIn(f'{unit}: 1 run ended unexpectedly', errors)

    def test_a_service_at_its_restart_limit_is_left_to_its_failure_alert(self):
        # A crash loop fast enough to reach the restart limit leaves the service
        # failed, which starts its own failure alert. systemd 255 logs the last
        # run's failure a second time; each run counts once.
        unit = 'screenr-worker.service'
        lines = restart_limit(NOW - 120, unit, 5)
        states = {**CrashHost().states, unit: ('failed', 'failed', 4)}
        code, output, errors = self.execute(CrashHost(lines, states=states))
        self.assertEqual(code, 0, errors)
        self.assertIn(f'{unit}: 5 runs ended unexpectedly', output)
        self.assertIn('It reached its restart limit, which its failure alert reports.', output)
        # The owner restarts it by hand, and it crashes again within the hour: the same loop.
        more = crash(NOW + 10 * MINUTE, unit, 'after-reset', 1)
        code, output, errors = self.execute(CrashHost([*lines, *more]), at=NOW + 15 * MINUTE)
        self.assertEqual(code, 0, errors)
        self.assertIn('part of a crash loop already reported', output)

    def test_ignores_other_units_and_entries_not_from_pid_1(self):
        lines = [
            *crash(NOW - 120, 'trading-web.service', 'trading', 1),
            # The names of probes that earlier issues ran on the host.
            *crash(NOW - 120, 'screenr-535b-worker-crash.service', 'probe', 1, 'signal'),
            # Any local process can log the same fields, but only PID 1 is systemd.
            {**systemd(NOW - 60, 'screenr-web.service', FAILED, "Failed with result 'signal'.",
                       UNIT_RESULT='signal', INVOCATION_ID='forged'), '_PID': '4242'},
            # Other systemd messages about a service.
            *crash(NOW - 60, 'screenr-db.service', 'db', 1)[2:],
        ]
        code, output, errors = self.execute(CrashHost(lines))
        self.assertEqual(code, 0, errors)
        self.assertIn('No Screenr service ended unexpectedly', output)

    def test_each_check_reads_from_where_the_previous_one_stopped(self):
        unit = 'screenr-db.service'
        code, _, errors = self.execute(CrashHost())
        self.assertEqual(code, 0, errors)
        # A crash between checks, even one missed while the host was down, is read once.
        between = crash(NOW + 60, unit, 'between', 1)
        code, _, errors = self.execute(CrashHost(between), at=NOW + 3 * HOUR)
        self.assertEqual(code, 1)
        self.assertIn(f'{unit}: 1 run ended unexpectedly', errors)
        code, output, errors = self.execute(CrashHost(between), at=NOW + 3 * HOUR + 5 * MINUTE)
        self.assertEqual(code, 0, errors)
        self.assertIn('No Screenr service ended unexpectedly', output)

    def test_first_check_reads_only_the_last_hour(self):
        older = crash(NOW - HOUR - 60, 'screenr-web.service', 'older', 1)
        code, output, errors = self.execute(CrashHost(older))
        self.assertEqual(code, 0, errors)
        self.assertIn('No Screenr service ended unexpectedly since 2026-11-05 16:33:20 UTC', output)

    def test_unreadable_journal_fails_and_is_read_again_next_time(self):
        problem = crash(NOW + 60, 'screenr-worker.service', 'missed', 1)
        code, _, errors = self.execute(CrashHost())
        self.assertEqual(code, 0, errors)
        saved = (self.state / 'state.json').read_text()
        for host in [CrashHost(problem, journal_error=subprocess.CalledProcessError(1, 'journalctl')),
                     CrashHost(problem, journal_error=FileNotFoundError('journalctl')),
                     CrashHost(problem, journal_error=subprocess.TimeoutExpired('journalctl', 300))]:
            with self.subTest(error=type(host.journal_error).__name__):
                code, _, errors = self.execute(host, at=NOW + 5 * MINUTE)
                self.assertEqual(code, 1)
                self.assertIn('Crash check failed', errors)
                self.assertEqual((self.state / 'state.json').read_text(), saved)
        # Without the systemd-journal group, journalctl can show nothing and succeed.
        hidden = CrashHost(problem)
        hidden.entries = []
        code, _, errors = self.execute(hidden, at=NOW + 5 * MINUTE)
        self.assertEqual(code, 1)
        self.assertIn('Crash check failed: cannot read the system journal', errors)
        self.assertEqual((self.state / 'state.json').read_text(), saved)
        code, _, errors = self.execute(CrashHost(problem), at=NOW + 10 * MINUTE)
        self.assertEqual(code, 1)
        self.assertIn('screenr-worker.service: 1 run ended unexpectedly', errors)

    def test_dry_run_reports_without_saving_state(self):
        host = CrashHost(crash(NOW - 60, 'screenr-web.service', 'one', 1))
        code, _, errors = self.execute(host, '--dry-run', *SERVICES)
        self.assertEqual(code, 1)
        self.assertIn('screenr-web.service: 1 run ended unexpectedly', errors)
        self.assertEqual(self.saved(), [])
        code, _, errors = self.execute(host)
        self.assertEqual(code, 1)
        self.assertIn('screenr-web.service: 1 run ended unexpectedly', errors)

    def test_a_service_that_is_not_loaded_fails_the_check(self):
        states = {unit: ('active', 'running', 0) for unit in SERVICES if unit != 'screenr-db.service'}
        code, _, errors = self.execute(CrashHost(states=states))
        self.assertEqual(code, 1)
        self.assertIn('Crash check failed: screenr-db.service is not-found, not loaded', errors)
        self.assertEqual(self.saved(), [])

    def test_invalid_saved_state_fails_the_check(self):
        for text in ['not json', '{}', '{"checked_until": "yesterday", "ended": {}}', '[]',
                     '{"checked_until": "2026-11-05T18:00:00+00:00", "ended": []}',
                     '{"checked_until": "2026-11-05T18:00:00+00:00", "ended": {"screenr-web.service": 3}}']:
            with self.subTest(text=text):
                (self.state / 'state.json').write_text(text)
                code, _, errors = self.execute(CrashHost())
                self.assertEqual(code, 1)
                self.assertIn('Invalid saved state', errors)
                self.assertEqual((self.state / 'state.json').read_text(), text)

    def test_refuses_units_that_are_not_screenr_services_before_reading(self):
        for units in [('sshd.service',), ('screenr-web.service; true',), ('../screenr-web.service',),
                      ('screenr-backup.timer',), ('',)]:
            with self.subTest(units=units):
                host = CrashHost()
                code, _, _ = self.execute(host, *units)
                self.assertNotEqual(code, 0)
                self.assertEqual(host.commands, [])
                self.assertEqual(self.saved(), [])


def interval(spec):
    """Return the seconds between a repeating OnCalendar=*:0/N timer's runs."""
    match = re.fullmatch(r'\*:0?0/(\d+)', spec)
    if not match:
        raise AssertionError(f'{spec} does not repeat every few minutes')
    return int(match[1]) * MINUTE


def seconds(span):
    """Return a systemd time span such as 1min or 30s in seconds."""
    match = re.fullmatch(r'(\d+)(s|min)', span)
    if not match:
        raise AssertionError(f'Unexpected time span {span}')
    return int(match[1]) * {'s': 1, 'min': MINUTE}[match[2]]


class CrashCheckUnitTests(unittest.TestCase):
    def test_check_watches_every_long_running_service(self):
        command = unit_file('screenr-crash-check.service')['Service']['ExecStart'][0].split()
        self.assertEqual(command[:2], ['/usr/bin/python3', '/usr/local/lib/screenr-deploy/check-crashes.py'])
        self.assertTrue(CHECK.is_file())
        self.assertEqual(sorted(command[2:]), long_running_services())
        self.assertEqual(sorted(command[2:]), sorted(SERVICES))

    def test_check_failure_starts_the_alert(self):
        self.assertEqual(unit_file('screenr-crash-check.service')['Unit'].get('OnFailure'),
                         ['screenr-alert@%n.service'])

    def test_check_reads_the_journal_without_root_or_secrets(self):
        service = unit_file('screenr-crash-check.service')['Service']
        self.assertEqual(service['Type'], ['oneshot'])
        # systemctl needs systemd's D-Bus API, which dynamic users cannot reach
        # on the host, and screenr-db cannot read other units' journal entries
        # without the journal group.
        self.assertNotIn('DynamicUser', service)
        self.assertEqual(service['User'], ['screenr-db'])
        self.assertEqual(service['SupplementaryGroups'], ['systemd-journal'])
        self.assertNotIn('EnvironmentFile', service)
        self.assertEqual(service['StateDirectory'], ['screenr-crash-check'])
        self.assertNotIn('ReadWritePaths', service)

    def test_a_crash_alerts_within_15_minutes(self):
        # A crash-looping worker stops sign-in codes, so the check runs on its
        # own timer, at least every 15 minutes, and catches up after downtime.
        # systemd may start a run up to AccuracySec late, a minute by default,
        # plus any random delay; the check itself takes seconds.
        timer = unit_file('screenr-crash-check.timer')['Timer']
        latest = (interval(timer['OnCalendar'][0]) + seconds(timer.get('AccuracySec', ['1min'])[0])
                  + seconds(timer.get('RandomizedDelaySec', ['0s'])[0]))
        self.assertLessEqual(latest, 10 * MINUTE)
        self.assertEqual(timer['Persistent'], ['true'])
        self.assertEqual(unit_file('screenr-crash-check.timer')['Install']['WantedBy'], ['timers.target'])


if __name__ == '__main__':
    unittest.main()
