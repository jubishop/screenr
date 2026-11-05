"""Exercise the daily memory check with a fake systemctl and journalctl, and check its units."""
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

from test_failure_alert import unit_file

ROOT = Path(__file__).resolve().parents[1]
CHECK = ROOT / 'ops/check-memory.py'
SERVICES = ('screenr-web.service', 'screenr-worker.service', 'screenr-db.service')
MIB = 1 << 20
LIMITS = {'screenr-web.service': 384 * MIB, 'screenr-worker.service': 128 * MIB,
          'screenr-db.service': 256 * MIB, 'trading-web.service': 64 * MIB}
DAY = 86400
NOW = 1_793_900_000
# The journal message IDs that systemd 255 logs when a unit's run ends with its
# resource use, and when the OOM killer kills one of its processes.
RESOURCES = 'ae8f7b866b0347b9af31fe1c80b127c0'
OOM = 'fe6faa94e7774663a0da52717891d8ef'
STARTED = '39f53479d3a045ac8e11786248231fbf'
# Fields that journalctl's JSON output always includes.
ALWAYS = ('__CURSOR', '__REALTIME_TIMESTAMP', '__MONOTONIC_TIMESTAMP', '_BOOT_ID')


def entry(at, **fields):
    return {'__REALTIME_TIMESTAMP': str(int(at * 1_000_000)), '__MONOTONIC_TIMESTAMP': '1',
            '__CURSOR': f's=fixture;t={int(at * 1_000_000)}', '_BOOT_ID': 'fixture-boot', **fields}


def systemd(at, unit, message_id, message, **fields):
    return entry(at, _PID='1', _UID='0', _TRANSPORT='journal', SYSLOG_IDENTIFIER='systemd',
                 MESSAGE_ID=message_id, UNIT=unit, MESSAGE=f'{unit}: {message}', **fields)


def run_ended(at, unit, peak, pid='1', invocation=None):
    """systemd's line for a run that ended, with the memory peak it last read, in bytes."""
    line = systemd(at, unit, RESOURCES, f'Consumed 12.3s CPU time, {peak / MIB:.1f}M memory peak, '
                   '0B memory swap peak.', MEMORY_PEAK=str(peak), CPU_USAGE_NSEC='12300000000',
                   INVOCATION_ID=invocation or f'ended-{unit}-{at}')
    return {**line, '_PID': pid}


def run_ended_unread(at, unit):
    """systemd 255 logs no peak for a run whose memory peak nothing read."""
    return systemd(at, unit, RESOURCES, 'Consumed 12.3s CPU time.', CPU_USAGE_NSEC='12300000000',
                   INVOCATION_ID=f'unread-{unit}-{at}')


def systemd_oom(at, unit):
    return systemd(at, unit, OOM, 'A process of this unit has been killed by the OOM killer.')


def kernel(at, message):
    return entry(at, _TRANSPORT='kernel', SYSLOG_IDENTIFIER='kernel', PRIORITY='6', MESSAGE=message)


def kernel_oom(at, unit, task='node', pid=4242):
    # Linux 6.8's summary line for a kill at a unit's MemoryMax, as the host logs it.
    memcg = f'/system.slice/{unit}'
    return kernel(at, f'oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,'
                      f'oom_memcg={memcg},task_memcg={memcg},task={task},pid={pid},uid=996')


# PID 1 logs every day, so a readable journal always has its entries.
BACKGROUND = [systemd(NOW - hours * 3600, 'trading-midday.service', STARTED, 'Started trading-midday.service.')
              for hours in range(0, 72, 6)]


class FakeHost:
    """systemctl show and journalctl over fixture units and journal entries.

    journalctl follows its documented match rules: matches on one field are
    alternatives, different fields must all match, and '+' separates
    alternative groups. --since and --until are inclusive.
    """

    def __init__(self, entries=(), limits=None, runs=None, journal_error=None):
        self.entries = sorted([*BACKGROUND, *entries], key=lambda item: int(item['__REALTIME_TIMESTAMP']))
        self.limits = LIMITS if limits is None else limits
        # {unit: (invocation ID, memory peak)} for each active service's current run.
        self.runs = runs or {}
        self.journal_error = journal_error
        self.commands = []

    def run(self, command, **options):
        command = list(command)
        self.commands.append(command)
        if options.get('timeout') is None or options['timeout'] <= 0:
            raise AssertionError(f'{command[0]} runs without a timeout')
        if command[0] == 'systemctl':
            return self.systemctl(command, options)
        if command[0] == 'journalctl':
            return self.journalctl(command, options)
        raise AssertionError(f'Unexpected command {command}')

    def systemctl(self, command, options):
        unit = command[2]
        if command[:2] != ['systemctl', 'show'] or len(command) != 4 or \
                command[3] != '--property=LoadState,MemoryMax,ActiveState,InvocationID,MemoryPeak':
            raise AssertionError(f'Unexpected systemctl call {command}')
        limit = self.limits.get(unit)
        # An inactive or failed unit keeps its last invocation ID, and a failed
        # one a memory peak that systemd 255 does not keep up to date.
        invocation, peak = self.runs.get(unit, (f'last-{unit}', None))
        state = 'active' if peak is not None else 'inactive'
        output = (f'LoadState={"loaded" if limit is not None else "not-found"}\n'
                  f'MemoryMax={limit if limit is not None else "infinity"}\nActiveState={state}\n'
                  f'InvocationID={invocation if limit is not None else ""}\n'
                  f'MemoryPeak={peak if peak is not None else "[not set]"}\n')
        return subprocess.CompletedProcess(command, 0, stdout=output)

    def journalctl(self, command, options):
        if self.journal_error:
            raise self.journal_error
        since, until, lines, fields, groups = None, None, None, None, [{}]
        for argument in command[1:]:
            if argument in ('--quiet', '--no-pager', '--output=json'):
                continue
            if argument.startswith('--since=@'):
                since = round(float(argument.removeprefix('--since=@')) * 1_000_000)
            elif argument.startswith('--until=@'):
                until = round(float(argument.removeprefix('--until=@')) * 1_000_000)
            elif argument.startswith('--lines='):
                lines = int(argument.removeprefix('--lines='))
            elif argument.startswith('--output-fields='):
                fields = argument.removeprefix('--output-fields=').split(',')
            elif argument == '+':
                groups.append({})
            elif '=' in argument and not argument.startswith('-'):
                field, value = argument.split('=', 1)
                groups[-1].setdefault(field, set()).add(value)
            else:
                # -k and -b need the boot ID, which the sandbox hides: on the host,
                # journalctl fails with "Failed to get boot id".
                raise AssertionError(f'Unsupported journalctl argument {argument!r}')
        if not any(groups):
            groups = []
        if [] in [list(group) for group in groups]:
            raise AssertionError(f"Empty match group in {command}")
        shown = [item for item in self.entries
                 if (since is None or int(item['__REALTIME_TIMESTAMP']) >= since)
                 and (until is None or int(item['__REALTIME_TIMESTAMP']) <= until)
                 and (not groups or any(all(item.get(field) in values for field, values in group.items())
                                        for group in groups))]
        if lines is not None:
            shown = shown[-lines:] if lines else []
        if fields is not None:
            shown = [{key: value for key, value in item.items() if key in fields or key in ALWAYS}
                     for item in shown]
        return subprocess.CompletedProcess(command, 0, stdout=''.join(json.dumps(item) + '\n' for item in shown))


class MemoryCheckTests(unittest.TestCase):
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

    def test_passes_when_every_run_stays_at_or_under_75_percent_of_its_limit(self):
        # 96 MiB is exactly 75% of the worker's 128 MiB.
        host = FakeHost([run_ended(NOW - 3600, 'screenr-worker.service', 96 * MIB),
                         run_ended(NOW - 7200, 'screenr-worker.service', 55 * MIB),
                         run_ended(NOW - 3600, 'screenr-web.service', 200 * MIB)])
        code, output, errors = self.execute(host)
        self.assertEqual(code, 0, errors)
        self.assertEqual(errors, '')
        self.assertIn('screenr-worker.service: highest peak 96.0 MiB, 75% of its 128 MiB MemoryMax, '
                      'in 2 runs that ended', output)
        self.assertIn('screenr-web.service: highest peak 200.0 MiB, 52% of its 384 MiB MemoryMax, '
                      'in 1 run that ended', output)
        self.assertIn('screenr-db.service: no run that ended logged its peak', output)
        self.assertIn('no OOM kill', output)

    def test_fails_when_a_run_peaks_above_75_percent_of_its_limit(self):
        for unit, peak, text in [('screenr-worker.service', 96 * MIB + 1, '96.0 MiB, 75% of its 128 MiB'),
                                 ('screenr-worker.service', 100 * MIB, '100.0 MiB, 78% of its 128 MiB'),
                                 ('screenr-web.service', 300 * MIB, '300.0 MiB, 78% of its 384 MiB'),
                                 ('screenr-db.service', 200 * MIB, '200.0 MiB, 78% of its 256 MiB')]:
            with self.subTest(unit=unit, peak=peak):
                for path in self.state.iterdir():
                    path.unlink()
                code, _, errors = self.execute(FakeHost([run_ended(NOW - 3600, unit, peak)]))
                self.assertEqual(code, 1)
                self.assertIn(f'{unit}: a run that ended at ', errors)
                self.assertIn(f'peaked at {text} MemoryMax, above the 75% limit', errors)

    def test_fails_when_systemd_reports_an_oom_kill(self):
        code, _, errors = self.execute(FakeHost([systemd_oom(NOW - 600, 'screenr-worker.service')]))
        self.assertEqual(code, 1)
        self.assertIn('screenr-worker.service: systemd reports a process killed by the OOM killer at ', errors)

    def test_fails_when_the_kernel_log_has_an_oom_kill_of_a_screenr_process(self):
        for unit, task in [('screenr-worker.service', 'node'), ('screenr-db.service', 'postgres')]:
            with self.subTest(unit=unit):
                for path in self.state.iterdir():
                    path.unlink()
                code, _, errors = self.execute(FakeHost([kernel_oom(NOW - 600, unit, task, 4242)]))
                self.assertEqual(code, 1)
                self.assertIn(f'{unit}: the kernel OOM-killed {task} (pid 4242) at ', errors)
        # A system-wide OOM kill names the task's cgroup the same way.
        for path in self.state.iterdir():
            path.unlink()
        code, _, errors = self.execute(FakeHost([kernel(
            NOW - 600, 'oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,'
                       'global_oom,task_memcg=/system.slice/screenr-web.service,task=next-server,pid=77,uid=996')]))
        self.assertEqual(code, 1)
        self.assertIn('screenr-web.service: the kernel OOM-killed next-server (pid 77)', errors)

    def test_fails_when_a_current_run_has_peaked_above_75_percent_of_its_limit(self):
        # A run's line when it stops carries only the peak last read, if any,
        # so each check also reads the current runs.
        runs = {'screenr-db.service': ('db-run', 200 * MIB), 'screenr-worker.service': ('worker-run', 50 * MIB)}
        code, output, errors = self.execute(FakeHost(runs=runs))
        self.assertEqual(code, 1)
        self.assertIn('screenr-db.service: the current run has peaked at 200.0 MiB, 78% of its 256 MiB '
                      'MemoryMax, above the 75% limit', errors)
        self.assertNotIn('screenr-worker.service', errors)
        self.assertIn('screenr-worker.service: current run 50.0 MiB, 39% of its 128 MiB MemoryMax', output)

    def test_reports_each_run_above_the_limit_once(self):
        runs = {'screenr-db.service': ('db-run', 200 * MIB)}
        code, _, errors = self.execute(FakeHost(runs=runs))
        self.assertEqual(code, 1)
        self.assertIn('the current run has peaked at 200.0 MiB', errors)
        # The next day the same run, still going and higher, sends no new alert.
        code, output, errors = self.execute(FakeHost(runs={'screenr-db.service': ('db-run', 230 * MIB)}),
                                            at=NOW + DAY)
        self.assertEqual(code, 0, errors)
        self.assertIn('screenr-db.service: current run 230.0 MiB, 90% of its 256 MiB MemoryMax, '
                      'already reported', output)
        # Nor does its line when it stops, but the next run above the limit does.
        ended = run_ended(NOW + DAY + 600, 'screenr-db.service', 240 * MIB, invocation='db-run')
        code, _, errors = self.execute(FakeHost([ended], runs={'screenr-db.service': ('next-run', 220 * MIB)}),
                                       at=NOW + 2 * DAY)
        self.assertEqual(code, 1)
        self.assertNotIn('240.0 MiB', errors)
        self.assertIn('screenr-db.service: the current run has peaked at 220.0 MiB', errors)

    def test_runs_that_ended_without_a_logged_peak_pass(self):
        code, output, errors = self.execute(FakeHost([run_ended_unread(NOW - 600, 'screenr-worker.service')]))
        self.assertEqual(code, 0, errors)
        self.assertIn('screenr-worker.service: no run that ended logged its peak', output)

    def test_ignores_other_units_and_other_kernel_messages(self):
        host = FakeHost([
            run_ended(NOW - 600, 'trading-web.service', 60 * MIB),
            systemd_oom(NOW - 600, 'trading-web.service'),
            kernel_oom(NOW - 600, 'trading-web.service', 'python3'),
            kernel(NOW - 600, '[UFW BLOCK] IN=eth0 OUT= SRC=203.0.113.9 DST=198.51.100.2 PROTO=TCP'),
            kernel(NOW - 600, 'Memory cgroup stats for /system.slice/screenr-worker.service:'),
            # Any local process can send the journal a message with these fields,
            # but only PID 1 is systemd.
            run_ended(NOW - 600, 'screenr-worker.service', 127 * MIB, pid='4242'),
        ])
        code, output, errors = self.execute(host)
        self.assertEqual(code, 0, errors)
        self.assertIn('screenr-worker.service: no run that ended logged its peak', output)

    def test_each_check_reads_from_where_the_previous_one_stopped(self):
        late = [run_ended(NOW - 3600, 'screenr-worker.service', 120 * MIB)]
        # The first check reads the last day and reports the peak once.
        code, _, errors = self.execute(FakeHost(late))
        self.assertEqual(code, 1)
        self.assertIn('peaked at 120.0 MiB', errors)
        # The next check, run late by the timer's random delay, misses nothing
        # that happened more than a day before it, and repeats nothing.
        between = run_ended(NOW + 300, 'screenr-web.service', 380 * MIB)
        code, _, errors = self.execute(FakeHost([*late, between]), at=NOW + DAY + 600)
        self.assertEqual(code, 1)
        self.assertIn('screenr-web.service: a run that ended at 2026-11-05', errors)
        self.assertNotIn('120.0 MiB', errors)
        code, output, errors = self.execute(FakeHost([*late, between]), at=NOW + 2 * DAY)
        self.assertEqual(code, 0, errors)
        self.assertIn('screenr-web.service: no run that ended logged its peak', output)

    def test_first_check_reads_only_the_last_day(self):
        code, output, errors = self.execute(FakeHost([systemd_oom(NOW - DAY - 60, 'screenr-worker.service'),
                                                      run_ended(NOW - DAY - 60, 'screenr-worker.service',
                                                                127 * MIB)]))
        self.assertEqual(code, 0, errors)
        self.assertIn('no OOM kill', output)

    def test_unreadable_journal_fails_and_is_read_again_next_time(self):
        problem = [systemd_oom(NOW + 600, 'screenr-web.service')]
        code, _, errors = self.execute(FakeHost())
        self.assertEqual(code, 0, errors)
        saved = (self.state / 'state.json').read_text()
        # Without the systemd-journal group, journalctl opens no files and
        # exits 1; with partial access it can exit 0 and show nothing.
        for host in [FakeHost(problem, journal_error=subprocess.CalledProcessError(1, 'journalctl')),
                     FakeHost(problem, journal_error=FileNotFoundError('journalctl')),
                     FakeHost(problem, journal_error=subprocess.TimeoutExpired('journalctl', 300))]:
            with self.subTest(error=type(host.journal_error).__name__):
                code, output, errors = self.execute(host, at=NOW + DAY)
                self.assertEqual(code, 1)
                self.assertIn('Memory check failed', errors)
                self.assertEqual((self.state / 'state.json').read_text(), saved)
        hidden = FakeHost(problem)
        hidden.entries = []
        code, _, errors = self.execute(hidden, at=NOW + DAY)
        self.assertEqual(code, 1)
        self.assertIn('Memory check failed: cannot read the system journal', errors)
        self.assertEqual((self.state / 'state.json').read_text(), saved)
        # The next readable check still covers the problem.
        code, _, errors = self.execute(FakeHost(problem), at=NOW + 2 * DAY)
        self.assertEqual(code, 1)
        self.assertIn('screenr-web.service: systemd reports a process killed by the OOM killer', errors)

    def test_dry_run_reports_without_saving_state(self):
        host = FakeHost([systemd_oom(NOW - 600, 'screenr-worker.service')])
        code, _, errors = self.execute(host, '--dry-run', *SERVICES)
        self.assertEqual(code, 1)
        self.assertIn('OOM killer', errors)
        self.assertEqual(self.saved(), [])
        code, _, errors = self.execute(host)
        self.assertEqual(code, 1)
        self.assertIn('OOM killer', errors)

    def test_a_service_without_a_memory_limit_fails_the_check(self):
        for limits in [{**LIMITS, 'screenr-db.service': 'infinity'},
                       {unit: limit for unit, limit in LIMITS.items() if unit != 'screenr-db.service'}]:
            with self.subTest(limits=limits.get('screenr-db.service')):
                code, _, errors = self.execute(FakeHost(limits=limits))
                self.assertEqual(code, 1)
                self.assertIn('Memory check failed: screenr-db.service', errors)
                self.assertEqual(self.saved(), [])

    def test_invalid_saved_state_fails_the_check(self):
        for text in ['not json', '{}', '{"checked_until": "yesterday"}', '[]']:
            with self.subTest(text=text):
                (self.state / 'state.json').write_text(text)
                code, _, errors = self.execute(FakeHost())
                self.assertEqual(code, 1)
                self.assertIn('Invalid saved state', errors)
                self.assertEqual((self.state / 'state.json').read_text(), text)

    def test_refuses_units_that_are_not_screenr_services_before_reading(self):
        for units in [('sshd.service',), ('screenr-web.service; true',), ('../screenr-web.service',),
                      ('screenr-backup.timer',), ('',)]:
            with self.subTest(units=units):
                host = FakeHost()
                code, _, _ = self.execute(host, *units)
                self.assertNotEqual(code, 0)
                self.assertEqual(host.commands, [])
                self.assertEqual(self.saved(), [])


def long_running_services():
    return sorted(path.name for path in (ROOT / 'ops').glob('screenr-*.service')
                  if unit_file(path.name).get('Install', {}).get('WantedBy') == ['multi-user.target'])


class MemoryCheckUnitTests(unittest.TestCase):
    def test_check_watches_every_long_running_service_and_its_memory_limit(self):
        service = unit_file('screenr-memory-check.service')['Service']
        command = service['ExecStart'][0].split()
        self.assertEqual(command[:2], ['/usr/bin/python3', '/usr/local/lib/screenr-deploy/check-memory.py'])
        self.assertTrue(CHECK.is_file())
        self.assertEqual(sorted(command[2:]), long_running_services())
        self.assertEqual(sorted(command[2:]), sorted(SERVICES))
        for unit in command[2:]:
            with self.subTest(unit=unit):
                self.assertEqual(len(unit_file(unit)['Service'].get('MemoryMax', [])), 1)

    def test_check_failure_starts_the_alert(self):
        self.assertEqual(unit_file('screenr-memory-check.service')['Unit'].get('OnFailure'),
                         ['screenr-alert@%n.service'])

    def test_check_reads_the_journal_without_root_or_secrets(self):
        service = unit_file('screenr-memory-check.service')['Service']
        self.assertEqual(service['Type'], ['oneshot'])
        # systemctl needs systemd's D-Bus API, which dynamic users cannot reach
        # on the host, and screenr-db cannot read other units' journal entries
        # or the kernel's without the journal group.
        self.assertNotIn('DynamicUser', service)
        self.assertEqual(service['User'], ['screenr-db'])
        self.assertEqual(service['SupplementaryGroups'], ['systemd-journal'])
        self.assertNotIn('EnvironmentFile', service)
        self.assertEqual(service['StateDirectory'], ['screenr-memory-check'])
        self.assertNotIn('ReadWritePaths', service)

    def test_check_runs_daily_and_catches_up_after_downtime(self):
        timer = unit_file('screenr-memory-check.timer')
        day, _, zone = timer['Timer']['OnCalendar'][0].split()
        self.assertEqual((day, zone), ('*-*-*', 'UTC'))
        self.assertEqual(timer['Timer']['Persistent'], ['true'])
        self.assertEqual(timer['Install']['WantedBy'], ['timers.target'])


if __name__ == '__main__':
    unittest.main()
