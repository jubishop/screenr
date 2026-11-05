#!/usr/bin/env python3
"""Fail when a Screenr service's run peaked above 75% of its MemoryMax or was OOM-killed.

Runs daily. Reads each service's current run, and the journal from where the
previous check stopped, or the last day on the first run: systemd's line for
each run that stopped, with its memory peak, systemd's OOM-kill messages, and
the kernel's oom-kill lines. A failure starts the failure alert, which emails
the owner. Each run above the limit is reported once.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

LIMIT = 75
DAY = 86400
UNIT = re.compile(r'screenr-[a-z0-9-]+\.service')
# systemd's catalog IDs for a run's resource use, logged when the run ends, and
# for a process of a unit killed by the OOM killer. systemd 255 logs the memory
# peak it last read for the unit, which each service's ExecStopPost= reads as
# the run ends. A run logs its line only when it ends, possibly weeks later, so
# the check also reads each current run's peak.
RESOURCES = 'ae8f7b866b0347b9af31fe1c80b127c0'
OOM = 'fe6faa94e7774663a0da52717891d8ef'
# The kernel's summary of each OOM kill names the killed task's cgroup.
KERNEL_OOM = re.compile(r'oom-kill:.*[:,]task_memcg=(?P<memcg>[^,]+),task=(?P<task>[^,]*),pid=(?P<pid>\d+)')
# -k and -b need the boot ID, which the sandbox's ProcSubset=pid hides, so the
# kernel's lines are read with a _TRANSPORT=kernel match instead.
JOURNALCTL = ('journalctl', '--quiet', '--no-pager', '--output=json')
MIB = 1 << 20


def journal(*arguments):
    """Return the matching journal entries as dicts."""
    output = subprocess.run((*JOURNALCTL, *arguments), check=True, stdout=subprocess.PIPE,
                            encoding='utf-8', errors='replace', timeout=300).stdout
    return [json.loads(line) for line in output.splitlines() if line]


def service(unit):
    """Return a service's MemoryMax, and its current run's invocation ID and memory peak, if active."""
    output = subprocess.run(['systemctl', 'show', unit,
                             '--property=LoadState,MemoryMax,ActiveState,InvocationID,MemoryPeak'],
                            check=True, stdout=subprocess.PIPE, text=True, timeout=30).stdout
    state = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
    if state.get('LoadState') != 'loaded':
        raise ValueError(f'{unit} is {state.get("LoadState") or "unknown"}, not loaded')
    if not state.get('MemoryMax', '').isdigit():
        raise ValueError(f'{unit} has no MemoryMax to compare its peaks with')
    current = None
    if state.get('ActiveState') == 'active' and state.get('InvocationID') and state.get('MemoryPeak', '').isdigit():
        current = state['InvocationID'], int(state['MemoryPeak'])
    return int(state['MemoryMax']), current


def load(path):
    """Return the saved end of the previous check, in microseconds, and the runs it reported."""
    try:
        state = json.loads(path.read_text())
        until = microseconds(datetime.datetime.fromisoformat(state['checked_until']).timestamp())
        reported = state['reported']
        if not isinstance(reported, list) or not all(isinstance(run, str) for run in reported):
            raise TypeError
        return until, set(reported)
    except FileNotFoundError:
        return None, set()
    except (KeyError, TypeError, ValueError):
        raise ValueError(f'Invalid saved state in {path}') from None


def save(path, until, reported):
    moment = datetime.datetime.fromtimestamp(until / 1_000_000, datetime.timezone.utc)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump({'checked_until': moment.isoformat(), 'reported': sorted(reported)}, output)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def microseconds(seconds):
    return round(seconds * 1_000_000)


def when(entry):
    moment = datetime.datetime.fromtimestamp(int(entry['__REALTIME_TIMESTAMP']) / 1_000_000,
                                             datetime.timezone.utc)
    return moment.strftime('%Y-%m-%d %H:%M:%S UTC')


def over(peak, limit):
    return peak * 100 > limit * LIMIT


def usage(peak, limit):
    return f'{peak / MIB:.1f} MiB, {peak * 100 / limit:.0f}% of its {limit / MIB:.0f} MiB MemoryMax'


def window(since, until, *arguments):
    """Return the entries after since and up to until, both in microseconds."""
    entries = journal(f'--since=@{since / 1_000_000:.6f}', f'--until=@{until / 1_000_000:.6f}', *arguments)
    return [entry for entry in entries if since < int(entry['__REALTIME_TIMESTAMP']) <= until]


def inspect(services, since, until, reported):
    """Return the summary lines, the problems, and the runs above the limit that are still going."""
    problems, summary, going = [], [], set()
    for unit, (limit, current) in services.items():
        if current:
            invocation, peak = current
            known = invocation in reported
            if over(peak, limit):
                going.add(invocation)
                if not known:
                    problems.append(f'{unit}: the current run has peaked at {usage(peak, limit)}, '
                                    f'above the {LIMIT}% limit')
            summary.append(f'{unit}: current run {usage(peak, limit)}'
                           + (', already reported' if known and over(peak, limit) else ''))
        else:
            summary.append(f'{unit}: not running')
    systemd = window(since, until, '_PID=1', f'MESSAGE_ID={RESOURCES}', f'MESSAGE_ID={OOM}',
                     *(f'UNIT={unit}' for unit in services))
    kernel = window(since, until, '--output-fields=MESSAGE', '_TRANSPORT=kernel')
    peaks = {unit: [] for unit in services}
    for entry in systemd:
        unit = entry.get('UNIT')
        if unit not in services:
            continue
        if entry.get('MESSAGE_ID') == OOM:
            problems.append(f'{unit}: systemd reports a process killed by the OOM killer at {when(entry)}')
        elif str(entry.get('MEMORY_PEAK', '')).isdigit():
            peak, limit = int(entry['MEMORY_PEAK']), services[unit][0]
            peaks[unit].append(peak)
            if over(peak, limit) and entry.get('INVOCATION_ID') not in reported | going:
                problems.append(f'{unit}: a run that ended at {when(entry)} peaked at {usage(peak, limit)}, '
                                f'above the {LIMIT}% limit')
    for entry in kernel:
        match = KERNEL_OOM.search(entry.get('MESSAGE') if isinstance(entry.get('MESSAGE'), str) else '')
        unit = match and next((part for part in match['memcg'].split('/') if part in services), None)
        if unit:
            problems.append(f'{unit}: the kernel OOM-killed {match["task"]} (pid {match["pid"]}) '
                            f'at {when(entry)}')
    for unit, values in peaks.items():
        runs = len(values)
        summary.append(f'{unit}: highest peak {usage(max(values), services[unit][0])}, in {runs} '
                       f'run{"s" if runs > 1 else ""} that ended' if values
                       else f'{unit}: no run that ended logged its peak')
    return summary, problems, going


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--dry-run', action='store_true',
                        help='report without saving where this check stopped or what it reported')
    parser.add_argument('units', nargs='+', metavar='unit')
    arguments = parser.parse_args()
    for unit in arguments.units:
        if not UNIT.fullmatch(unit):
            print(f'Refusing to check {unit!r}: not a Screenr service', file=sys.stderr)
            return 2
    path = Path(os.environ.get('STATE_DIRECTORY', '/var/lib/screenr-memory-check')) / 'state.json'
    try:
        until = microseconds(time.time())
        since, reported = load(path)
        if since is None or since > until:
            since = until - DAY * 1_000_000
        services = {unit: service(unit) for unit in arguments.units}
        # Without the systemd-journal group, journalctl can show no entries and
        # still succeed. PID 1 logs every day, so the journal always has some.
        if not journal('--lines=1', '_PID=1'):
            raise ValueError('cannot read the system journal; the check needs the systemd-journal group')
        summary, problems, going = inspect(services, since, until, reported)
        if not arguments.dry_run:
            save(path, until, going)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f'Memory check failed: {error}', file=sys.stderr)
        return 1
    start = datetime.datetime.fromtimestamp(since / 1_000_000, datetime.timezone.utc)
    print(f'Checked the current runs, and the journal since {start:%Y-%m-%d %H:%M:%S} UTC')
    for line in summary:
        print(line)
    if problems:
        for line in problems:
            print(line, file=sys.stderr)
        return 1
    print(f'No run peaked above {LIMIT}% of its MemoryMax, and the journal shows no OOM kill')
    return 0


if __name__ == '__main__':
    sys.exit(main())
